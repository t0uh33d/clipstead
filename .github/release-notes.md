## Install the Mac app

1. Download **Clipstead.dmg** below, open it, and drag **Clipstead** into **Applications**.
2. This build is not notarized by Apple yet, so macOS blocks it the first time. Open **System Settings → Privacy &
   Security**, scroll to the message about Clipstead and click **Open Anyway**. (Or run
   `xattr -dr com.apple.quarantine /Applications/Clipstead.app` in Terminal.)
3. Click the clipboard icon in the menu bar, choose **Settings…**, enter your server's address, and pair from your
   web app (**Devices → Add a Mac**).

Clipstead syncs to a server you run yourself: deploy it to your own Cloudflare account with the
[self-hosting guide](https://github.com/t0uh33d/clipstead/blob/main/docs/self-hosting.md). Requires macOS 14 or later
on Apple silicon or Intel.

Verify the download with `shasum -a 256 -c Clipstead.dmg.sha256`, run in the folder that contains both files.
