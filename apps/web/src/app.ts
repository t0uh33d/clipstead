// Clipstead web UI. No dependencies. Every element is built with createElement and every piece of text is
// inserted as a text node, never as HTML, so clipboard content is always inert data.

// ---------------------------------------------------------------- types

type RegistrationMode = 'closed' | 'invite_only' | 'open';
interface Instance {
  setup_required: boolean;
  registration_mode: RegistrationMode;
}
interface Me {
  user: { id: string; username: string; is_admin: boolean; created_at: number };
  settings: { retention_hours: number | null };
  storage: { used_bytes: number; quota_bytes: number };
}
interface Entry {
  id: string;
  size_bytes: number;
  created_at: number;
  device_name: string | null;
  preview: string;
  truncated: boolean;
}
interface Device {
  id: string;
  name: string;
  platform: string;
  created_at: number;
  last_seen_at: number | null;
}
interface Pairing {
  id: string;
  status: 'waiting' | 'claimed' | 'approved' | 'completed' | 'expired';
  expires_at: number;
  code?: string;
  device: {
    name: string;
    platform: string;
    app_version: string | null;
    ip: string | null;
    country: string | null;
    claimed_at: number;
  } | null;
}
interface Session {
  id: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}
interface Invite {
  id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

// ---------------------------------------------------------------- DOM helpers

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | ((event: Event) => void)>;

function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

let fieldCount = 0;
function field(label: string, attrs: Attrs, hint?: string): { el: HTMLElement; input: HTMLInputElement } {
  const id = `field-${++fieldCount}`;
  const input = h('input', { id, ...attrs }) as HTMLInputElement;
  const hintEl = hint ? h('small', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return { el: h('div', { class: 'field' }, h('label', { for: id }, label), input, hintEl), input };
}

function select(
  label: string,
  options: [string, string][],
  value: string,
): { el: HTMLElement; input: HTMLSelectElement } {
  const id = `field-${++fieldCount}`;
  const input = h(
    'select',
    { id },
    ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)),
  ) as HTMLSelectElement;
  return { el: h('div', { class: 'field' }, h('label', { for: id }, label), input), input };
}

/** A form that uses native validation, disables itself while submitting and shows errors accessibly. */
function form(submitLabel: string, children: Child[], onSubmit: () => Promise<void>, danger = false): HTMLFormElement {
  const error = h('p', { class: 'error', role: 'alert' });
  const button = h(
    'button',
    { type: 'submit', class: danger ? 'danger' : 'primary' },
    submitLabel,
  ) as HTMLButtonElement;
  const el = h('form', {}, ...children, error, h('div', {}, button)) as HTMLFormElement;
  el.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await onSubmit();
    } catch (err) {
      error.textContent = message(err);
    } finally {
      button.disabled = false;
    }
  });
  return el;
}

const main = document.getElementById('main') as HTMLElement;
const topbar = document.getElementById('topbar') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;

function show(title: string, ...content: Child[]) {
  const heading = h('h1', { tabindex: -1 }, title);
  main.replaceChildren(heading);
  for (const child of content) if (child) main.append(child);
  document.title = `${title} · Clipstead`;
  heading.focus();
}

let toastTimer: number | undefined;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// ---------------------------------------------------------------- formatting

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

function ago(ms: number): string {
  const seconds = (ms - Date.now()) / 1000;
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return 'just now';
}

const time = (ms: number) =>
  h('time', { datetime: new Date(ms).toISOString(), title: new Date(ms).toLocaleString() }, ago(ms));

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function browserName(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

let me: Me | null = null;
let instance: Instance = { setup_required: false, registration_mode: 'closed' };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', navigator.onLine ? 'Could not reach the server.' : 'You are offline.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && me) {
      me = null;
      loginView('Your session ended. Please sign in again.');
    }
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

// ---------------------------------------------------------------- clipboard

async function fullText(id: string): Promise<string> {
  return (await api<{ entry: { content: string } }>('GET', `/clipboard/${id}`)).entry.content;
}

/** Copies an entry. Reports success only after the browser confirms the write. */
async function copyEntry(entry: Entry, button: HTMLButtonElement) {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
    if (!entry.truncated) {
      await navigator.clipboard.writeText(entry.preview);
    } else if (typeof ClipboardItem !== 'undefined') {
      // Safari only allows clipboard writes that start inside the click, so hand it a pending Blob.
      const blob = fullText(entry.id).then((text) => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await fullText(entry.id));
    }
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
    toast('Copied to clipboard.');
  } catch (err) {
    if (err instanceof ApiError) return toast(err.message);
    copyFallback(entry.truncated ? await fullText(entry.id).catch(() => entry.preview) : entry.preview);
  }
}

/** When the browser refuses clipboard access (permissions, insecure context), let the user copy by hand. */
function copyFallback(text: string) {
  const area = h('textarea', { readonly: true, rows: 8, 'aria-label': 'Clipboard text' }) as HTMLTextAreaElement;
  area.value = text;
  const dialog = h(
    'dialog',
    { 'aria-labelledby': 'copy-title' },
    h('h2', { id: 'copy-title' }, 'Copy manually'),
    h('p', {}, 'Your browser blocked clipboard access. The text below is selected; press ⌘C or Ctrl+C.'),
    area,
    h('form', { method: 'dialog' }, h('div', {}, h('button', { class: 'secondary' }, 'Close'))),
  ) as HTMLDialogElement;
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  area.select();
}

// ---------------------------------------------------------------- signed-out views

function setupView() {
  topbar.hidden = true;
  const token = field(
    'Setup token',
    { type: 'password', required: true, autocomplete: 'off' },
    'The SETUP_TOKEN secret you configured with wrangler.',
  );
  const username = field('Administrator username', {
    required: true,
    autocomplete: 'username',
    minlength: 3,
    maxlength: 32,
  });
  const password = field(
    'Password',
    { type: 'password', required: true, autocomplete: 'new-password', minlength: 12 },
    'At least 12 characters. A passphrase or password manager works best.',
  );
  const confirm = field('Confirm password', { type: 'password', required: true, autocomplete: 'new-password' });
  const mode = select(
    'New user registration',
    [
      ['closed', 'Closed: only you'],
      ['invite_only', 'Invite only: people you invite'],
      ['open', 'Open: anyone who can reach this site'],
    ],
    'closed',
  );
  show(
    'Set up Clipstead',
    h(
      'div',
      { class: 'card narrow' },
      h('p', {}, 'Create the administrator account for this instance. This page works only once.'),
      form('Create administrator', [token.el, username.el, password.el, confirm.el, mode.el], async () => {
        if (password.input.value !== confirm.input.value)
          throw new ApiError(400, 'mismatch', 'The passwords do not match.');
        await api('POST', '/setup', {
          setup_token: token.input.value,
          username: username.input.value,
          password: password.input.value,
          registration_mode: mode.input.value,
        });
        await boot();
      }),
    ),
  );
}

function loginView(notice = '') {
  topbar.hidden = true;
  const username = field('Username', { required: true, autocomplete: 'username', autocapitalize: 'none' });
  const password = field('Password', { type: 'password', required: true, autocomplete: 'current-password' });
  show(
    'Sign in',
    h(
      'div',
      { class: 'card narrow' },
      notice && h('p', { role: 'status' }, notice),
      form('Sign in', [username.el, password.el], async () => {
        await api('POST', '/auth/login', { username: username.input.value, password: password.input.value });
        await boot();
      }),
      instance.registration_mode !== 'closed' &&
        h(
          'p',
          {},
          'No account? ',
          h('button', { class: 'link', type: 'button', onclick: () => registerView() }, 'Create one'),
        ),
    ),
  );
}

function registerView() {
  const username = field(
    'Username',
    { required: true, autocomplete: 'username', autocapitalize: 'none', minlength: 3, maxlength: 32 },
    'Lowercase letters, digits, ".", "_" or "-".',
  );
  const password = field(
    'Password',
    { type: 'password', required: true, autocomplete: 'new-password', minlength: 12 },
    'At least 12 characters.',
  );
  const confirm = field('Confirm password', { type: 'password', required: true, autocomplete: 'new-password' });
  const invite =
    instance.registration_mode === 'invite_only'
      ? field('Invite code', { required: true, autocomplete: 'off', autocapitalize: 'characters' })
      : null;
  show(
    'Create account',
    h(
      'div',
      { class: 'card narrow' },
      form('Create account', [username.el, password.el, confirm.el, invite?.el], async () => {
        if (password.input.value !== confirm.input.value)
          throw new ApiError(400, 'mismatch', 'The passwords do not match.');
        await api('POST', '/auth/register', {
          username: username.input.value,
          password: password.input.value,
          invite_code: invite?.input.value,
        });
        await boot();
      }),
      h('p', {}, h('button', { class: 'link', type: 'button', onclick: () => loginView() }, 'Back to sign in')),
    ),
  );
}

// ---------------------------------------------------------------- signed-in shell

let pollTimer: number | undefined;

function renderTopbar(view: string) {
  if (!me) return;
  const link = (name: string, text: string) =>
    h('a', { href: `#/${name}`, 'aria-current': view === name ? 'page' : undefined }, text);
  topbar.replaceChildren(
    h('a', { class: 'brand', href: '#/history' }, 'Clipstead'),
    h(
      'nav',
      { 'aria-label': 'Main' },
      link('history', 'History'),
      link('devices', 'Devices'),
      link('settings', 'Settings'),
    ),
    h(
      'div',
      { class: 'who' },
      h('span', { class: 'muted' }, me.user.username),
      h('button', { class: 'link', type: 'button', onclick: signOut }, 'Sign out'),
    ),
  );
  topbar.hidden = false;
}

async function signOut() {
  try {
    await api('POST', '/auth/logout');
  } catch {
    // The session may already be gone; either way, show the sign-in page.
  }
  me = null;
  history.replaceState(null, '', '/');
  loginView('You are signed out.');
}

function route() {
  clearTimeout(pollTimer);
  document.onvisibilitychange = null;
  if (!me) return loginView();
  const view = location.hash.replace(/^#\//, '') || 'history';
  renderTopbar(view);
  if (view === 'devices') devicesView();
  else if (view === 'settings') settingsView();
  else historyView();
}

// ---------------------------------------------------------------- history

function historyView() {
  const search = h('input', {
    type: 'search',
    placeholder: 'Search your history',
    'aria-label': 'Search your history',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 200,
  }) as HTMLInputElement;
  const status = h('p', { class: 'muted', role: 'status' });
  const list = h('ul', { class: 'entries', 'aria-label': 'Clipboard history' });
  const more = h('button', { type: 'button', hidden: true }, 'Load more') as HTMLButtonElement;
  let cursor: string | null = null;
  let generation = 0;

  async function load(reset: boolean) {
    const current = reset ? ++generation : generation;
    if (reset) {
      cursor = null;
      status.textContent = 'Loading…';
    }
    more.disabled = true;
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (search.value.trim()) params.set('q', search.value.trim());
      if (cursor) params.set('cursor', cursor);
      const page = await api<{ entries: Entry[]; next_cursor: string | null }>('GET', `/clipboard?${params}`);
      if (current !== generation) return; // A newer search replaced this one.
      if (reset) list.replaceChildren();
      list.append(...page.entries.map((entry) => entryItem(entry)));
      cursor = page.next_cursor;
      more.hidden = !cursor;
      status.textContent = list.children.length
        ? ''
        : search.value.trim()
          ? 'No entries match your search.'
          : 'Nothing here yet. Pair a Mac on the Devices page, turn on sync, and copy some text.';
    } catch (err) {
      if (current === generation) status.textContent = message(err);
    } finally {
      more.disabled = false;
    }
  }

  function entryItem(entry: Entry): HTMLElement {
    const label = entry.preview.slice(0, 60).replace(/\s+/g, ' ');
    const copy = h(
      'button',
      { type: 'button', class: 'primary small', 'aria-label': `Copy “${label}”` },
      'Copy',
    ) as HTMLButtonElement;
    copy.addEventListener('click', () => copyEntry(entry, copy));
    const item = h(
      'li',
      { class: 'entry' },
      h('pre', {}, entry.truncated ? `${entry.preview}…` : entry.preview),
      h(
        'div',
        { class: 'meta' },
        time(entry.created_at),
        entry.device_name && h('span', {}, `· ${entry.device_name}`),
        h('span', {}, `· ${bytes(entry.size_bytes)}`),
        h(
          'span',
          { class: 'actions' },
          copy,
          h(
            'button',
            {
              type: 'button',
              class: 'small',
              'aria-label': `Delete “${label}”`,
              onclick: async () => {
                try {
                  await api('DELETE', `/clipboard/${entry.id}`);
                  item.remove();
                  toast('Entry deleted.');
                } catch (err) {
                  toast(message(err));
                }
              },
            },
            'Delete',
          ),
        ),
      ),
    );
    // Clicking the text copies it too, unless the user is selecting part of it.
    item.querySelector('pre')?.addEventListener('click', () => {
      if (!window.getSelection()?.toString()) copyEntry(entry, copy);
    });
    return item;
  }

  let debounce: number | undefined;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => load(true), 250);
  });
  more.addEventListener('click', () => load(false));
  // Pick up entries copied on a Mac while this tab was in the background.
  document.onvisibilitychange = () => {
    if (!document.hidden && !search.value) load(true);
  };

  show(
    'History',
    h(
      'div',
      { class: 'toolbar' },
      search,
      h('button', { type: 'button', onclick: () => load(true) }, 'Refresh'),
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: async () => {
            if (!confirm('Delete your entire clipboard history? This cannot be undone.')) return;
            try {
              await api('DELETE', '/clipboard');
              toast('History cleared.');
              load(true);
            } catch (err) {
              toast(message(err));
            }
          },
        },
        'Clear history',
      ),
    ),
    status,
    list,
    more,
  );
  load(true);
}

// ---------------------------------------------------------------- devices and pairing

function devicesView() {
  const list = h('ul', { class: 'rows', 'aria-label': 'Paired devices' });
  const status = h('p', { class: 'muted', role: 'status' }, 'Loading…');
  const pairingSlot = h('div', {});
  const add = h(
    'button',
    { type: 'button', class: 'primary', onclick: () => startPairing() },
    'Add a Mac',
  ) as HTMLButtonElement;

  async function load() {
    try {
      const { devices } = await api<{ devices: Device[] }>('GET', '/devices');
      list.replaceChildren(...devices.map(deviceRow));
      status.textContent = devices.length ? '' : 'No devices are paired yet.';
    } catch (err) {
      status.textContent = message(err);
    }
  }

  function deviceRow(device: Device): HTMLElement {
    return h(
      'li',
      { class: 'row' },
      h(
        'div',
        { class: 'grow' },
        h('strong', {}, device.name),
        h(
          'div',
          { class: 'muted' },
          `${device.platform} · paired `,
          time(device.created_at),
          ' · last seen ',
          device.last_seen_at ? time(device.last_seen_at) : 'never',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'small',
          onclick: async () => {
            const name = prompt('New name for this device', device.name);
            if (!name?.trim()) return;
            try {
              await api('PATCH', `/devices/${device.id}`, { name });
              load();
            } catch (err) {
              toast(message(err));
            }
          },
        },
        'Rename',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'small danger',
          onclick: async () => {
            const ok = confirm(
              `Revoke “${device.name}”? It stops syncing immediately. To use it again you will need to pair it again.`,
            );
            if (!ok) return;
            try {
              await api('DELETE', `/devices/${device.id}`);
              toast('Device revoked.');
              load();
            } catch (err) {
              toast(message(err));
            }
          },
        },
        'Revoke',
      ),
    );
  }

  async function startPairing() {
    clearTimeout(pollTimer);
    add.disabled = true;
    try {
      const { pairing } = await api<{ pairing: Pairing }>('POST', '/pairings');
      pairingSlot.replaceChildren(pairingPanel(pairing));
    } catch (err) {
      toast(message(err));
      add.disabled = false;
    }
  }

  function pairingPanel(initial: Pairing): HTMLElement {
    const panel = h('section', { class: 'card', 'aria-labelledby': 'pairing-title' });
    const live = h('p', { role: 'status' });
    const countdown = h('p', { class: 'muted' });
    let pairing = initial;
    let shown = '';

    const finish = () => {
      clearTimeout(pollTimer);
      pairingSlot.replaceChildren();
      add.disabled = false;
      load();
    };
    const cancel = async () => {
      clearTimeout(pollTimer);
      await api('DELETE', `/pairings/${pairing.id}`).catch(() => undefined);
      finish();
    };

    function render() {
      const seconds = Math.max(0, Math.round((pairing.expires_at - Date.now()) / 1000));
      countdown.textContent = `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.`;
      if (pairing.status === shown) return; // Only rebuild (and announce) on a status change.
      shown = pairing.status;
      const title = h('h2', { id: 'pairing-title' }, 'Add a Mac');
      if (pairing.status === 'waiting') {
        live.textContent = 'Waiting for your Mac to enter the code.';
        panel.replaceChildren(
          title,
          h(
            'ol',
            {},
            h('li', {}, 'Open Clipstead on your Mac and choose Settings → Pair.'),
            h('li', {}, 'Server address: ', h('span', { class: 'inline-code' }, location.origin)),
            h('li', {}, 'Pairing code:'),
          ),
          h(
            'p',
            { class: 'code', 'aria-label': `Pairing code ${(initial.code ?? '').split('').join(' ')}` },
            initial.code ?? '',
          ),
          countdown,
          live,
          h('div', { class: 'buttons' }, h('button', { type: 'button', onclick: cancel }, 'Cancel')),
        );
      } else if (pairing.status === 'claimed' && pairing.device) {
        const d = pairing.device;
        live.textContent = 'A device entered the code. Check its details before approving.';
        panel.replaceChildren(
          title,
          live,
          h(
            'dl',
            { class: 'details' },
            h('dt', {}, 'Device name'),
            h('dd', {}, d.name),
            h('dt', {}, 'System'),
            h('dd', {}, d.platform),
            h('dt', {}, 'App version'),
            h('dd', {}, d.app_version ?? 'unknown'),
            h('dt', {}, 'Network'),
            h('dd', {}, [d.ip, d.country].filter(Boolean).join(' · ') || 'unknown'),
            h('dt', {}, 'Requested'),
            h('dd', {}, time(d.claimed_at)),
          ),
          h(
            'p',
            { class: 'warning' },
            'Only approve if this is your Mac and you entered the code on it just now. An approved device can add entries to your history.',
          ),
          countdown,
          h(
            'div',
            { class: 'buttons' },
            h(
              'button',
              {
                type: 'button',
                class: 'primary',
                onclick: async () => {
                  try {
                    pairing = (await api<{ pairing: Pairing }>('POST', `/pairings/${pairing.id}/approve`)).pairing;
                    render();
                    poll();
                  } catch (err) {
                    toast(message(err));
                  }
                },
              },
              'Approve',
            ),
            h('button', { type: 'button', class: 'danger', onclick: cancel }, 'Deny'),
          ),
        );
      } else if (pairing.status === 'approved') {
        live.textContent = 'Approved. Waiting for the Mac to finish pairing…';
        panel.replaceChildren(title, live);
      } else if (pairing.status === 'completed') {
        live.textContent = `${pairing.device?.name ?? 'The device'} is paired. Turn on sync in the Mac app to start uploading.`;
        panel.replaceChildren(title, live, h('button', { type: 'button', class: 'primary', onclick: finish }, 'Done'));
      } else {
        live.textContent = 'This pairing code expired. Start again to get a new code.';
        panel.replaceChildren(
          title,
          live,
          h(
            'div',
            { class: 'buttons' },
            h('button', { type: 'button', class: 'primary', onclick: startPairing }, 'Start again'),
            h('button', { type: 'button', onclick: finish }, 'Close'),
          ),
        );
      }
    }

    function poll() {
      clearTimeout(pollTimer);
      if (pairing.status === 'completed' || pairing.status === 'expired' || pairing.status === 'claimed') return;
      pollTimer = window.setTimeout(async () => {
        try {
          pairing = (await api<{ pairing: Pairing }>('GET', `/pairings/${pairing.id}`)).pairing;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) pairing = { ...pairing, status: 'expired' };
        }
        if (pairing.status === 'waiting' && pairing.expires_at <= Date.now())
          pairing = { ...pairing, status: 'expired' };
        render();
        poll();
      }, 2000);
    }

    render();
    poll();
    return panel;
  }

  show(
    'Devices',
    h(
      'p',
      { class: 'muted' },
      'Each paired Mac has its own credential. Revoking a device stops it immediately; it must be paired again to reconnect.',
    ),
    h('div', { class: 'toolbar' }, add),
    pairingSlot,
    h('div', { class: 'card' }, status, list),
  );
  load();
}

// ---------------------------------------------------------------- settings

// Values are hours.
const RETENTION: [string, string][] = [
  ['1', '1 hour'],
  ['6', '6 hours'],
  ['24', '1 day'],
  ['168', '7 days'],
  ['720', '30 days'],
  ['8760', '1 year'],
  ['forever', 'Forever'],
];

async function settingsView() {
  // Refetch: storage usage and settings change while the app is open.
  const account = await api<Me>('GET', '/auth/me').catch(() => me);
  if (!account) return;
  me = account;

  const current = field('Current password', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = field(
    'New password',
    { type: 'password', required: true, autocomplete: 'new-password', minlength: 12 },
    'At least 12 characters.',
  );
  const passwordForm = form('Change password', [current.el, next.el], async () => {
    await api('POST', '/account/password', { current_password: current.input.value, new_password: next.input.value });
    passwordForm.reset();
    toast('Password changed. Your other sessions were signed out.');
    loadSessions();
  });

  const retention = select(
    'Keep clipboard history for',
    RETENTION,
    account.settings.retention_hours === null ? 'forever' : String(account.settings.retention_hours),
  );
  retention.input.addEventListener('change', async () => {
    const value = retention.input.value;
    try {
      await api('PATCH', '/account/settings', { retention_hours: value === 'forever' ? null : Number(value) });
      account.settings.retention_hours = value === 'forever' ? null : Number(value);
      toast('Retention updated. Older entries are hidden now and deleted within 15 minutes.');
    } catch (err) {
      toast(message(err));
    }
  });

  const sessions = h('ul', { class: 'rows', 'aria-label': 'Signed-in browsers' });
  async function loadSessions() {
    try {
      const res = await api<{ sessions: Session[] }>('GET', '/sessions');
      sessions.replaceChildren(
        ...res.sessions.map((s) =>
          h(
            'li',
            { class: 'row' },
            h(
              'div',
              { class: 'grow' },
              h('strong', {}, browserName(s.user_agent)),
              s.current && ' ',
              s.current && h('span', { class: 'badge' }, 'this browser'),
              h('div', { class: 'muted' }, 'Signed in ', time(s.created_at), ' · active ', time(s.last_seen_at)),
            ),
            !s.current &&
              h(
                'button',
                {
                  type: 'button',
                  class: 'small',
                  onclick: async () => {
                    try {
                      await api('DELETE', `/sessions/${s.id}`);
                      loadSessions();
                    } catch (err) {
                      toast(message(err));
                    }
                  },
                },
                'Sign out',
              ),
          ),
        ),
      );
    } catch (err) {
      sessions.replaceChildren(h('li', { class: 'error' }, message(err)));
    }
  }

  const deletePassword = field('Password', { type: 'password', required: true, autocomplete: 'current-password' });
  const deleteForm = form(
    'Delete my account',
    [h('p', {}, 'This permanently deletes your account, history, devices and sessions.'), deletePassword.el],
    async () => {
      if (!confirm('Delete your account and all of its data? This cannot be undone.')) return;
      await api('DELETE', '/account', { password: deletePassword.input.value });
      me = null;
      history.replaceState(null, '', '/');
      loginView('Your account was deleted.');
    },
    true,
  );

  const { used_bytes, quota_bytes } = account.storage;
  show(
    'Settings',
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Account'),
      h(
        'p',
        {},
        'Signed in as ',
        h('strong', {}, account.user.username),
        account.user.is_admin && ' ',
        account.user.is_admin && h('span', { class: 'badge' }, 'administrator'),
      ),
      passwordForm,
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'History'),
      retention.el,
      h(
        'p',
        { class: 'hint' },
        'Entries disappear when they reach this age and are deleted within 15 minutes. Cloudflare database backups (Time Travel) may keep them for up to 30 days.',
      ),
      h('p', {}, `Storage: ${bytes(used_bytes)} of ${bytes(quota_bytes)} used`),
      h('meter', { min: 0, max: quota_bytes, value: used_bytes, 'aria-label': 'Storage used' }),
    ),
    h('section', { class: 'card' }, h('h2', {}, 'Signed-in browsers'), sessions),
    account.user.is_admin && adminSection(),
    h('section', { class: 'card' }, h('h2', {}, 'Delete account'), deleteForm),
  );
  loadSessions();
}

function adminSection(): HTMLElement {
  const mode = select(
    'New user registration',
    [
      ['closed', 'Closed'],
      ['invite_only', 'Invite only'],
      ['open', 'Open to anyone'],
    ],
    instance.registration_mode,
  );
  mode.input.addEventListener('change', async () => {
    try {
      const res = await api<{ registration_mode: RegistrationMode }>('PATCH', '/admin/instance', {
        registration_mode: mode.input.value,
      });
      instance.registration_mode = res.registration_mode;
      toast('Registration setting saved.');
    } catch (err) {
      toast(message(err));
    }
  });

  const invites = h('ul', { class: 'rows', 'aria-label': 'Invites' });
  const created = h('div', { role: 'status' });
  async function loadInvites() {
    try {
      const res = await api<{ invites: Invite[] }>('GET', '/admin/invites');
      invites.replaceChildren(
        ...res.invites.map((invite) => {
          const state = invite.used_at
            ? `used by ${invite.used_by ?? 'a deleted account'}`
            : invite.expires_at <= Date.now()
              ? 'expired'
              : 'unused';
          return h(
            'li',
            { class: 'row' },
            h('div', { class: 'grow' }, `Invite created `, time(invite.created_at), ` · ${state}`),
            state === 'unused' &&
              h(
                'button',
                {
                  type: 'button',
                  class: 'small',
                  onclick: async () => {
                    await api('DELETE', `/admin/invites/${invite.id}`).catch((err) => toast(message(err)));
                    loadInvites();
                  },
                },
                'Revoke',
              ),
          );
        }),
      );
    } catch (err) {
      invites.replaceChildren(h('li', { class: 'error' }, message(err)));
    }
  }

  const create = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        try {
          const { invite } = await api<{ invite: { code: string; expires_at: number } }>('POST', '/admin/invites');
          created.replaceChildren(
            h(
              'div',
              {},
              h('p', {}, 'New invite code (shown once, valid for 7 days):'),
              h('p', { class: 'code' }, invite.code),
              instance.registration_mode !== 'invite_only' &&
                h('p', { class: 'hint' }, 'Set registration to “Invite only” for invite codes to work.'),
            ),
          );
          loadInvites();
        } catch (err) {
          toast(message(err));
        }
      },
    },
    'Create invite',
  );
  loadInvites();
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Instance (administrator)'),
    mode.el,
    h('p', { class: 'hint' }, 'Administrators manage registration only. They cannot see other users’ clipboards.'),
    h('div', { class: 'buttons' }, create),
    created,
    invites,
  );
}

// ---------------------------------------------------------------- startup

async function boot() {
  try {
    instance = await api<Instance>('GET', '/instance');
    if (instance.setup_required) return setupView();
    me = await api<Me>('GET', '/auth/me').catch((err) => {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    });
    route();
  } catch (err) {
    topbar.hidden = true;
    show(
      'Clipstead',
      h('p', { class: 'error', role: 'alert' }, message(err)),
      h('button', { type: 'button', onclick: boot }, 'Try again'),
    );
  }
}

const offline = document.getElementById('offline') as HTMLElement;
const updateOnline = () => {
  offline.hidden = navigator.onLine;
};
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
window.addEventListener('hashchange', route);
updateOnline();
boot();
