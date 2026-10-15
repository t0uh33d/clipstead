-- Rich clipboard content. All of it is stored and served as data; the web app never renders it as markup.
--
-- Formatted text: `html` holds the formatted version of a text entry. It is only written back to clipboards, so
-- pasting keeps bold, links and lists.
ALTER TABLE clipboard_entries ADD COLUMN html TEXT;

-- Images: `content` holds a short label (e.g. "Image 1920 × 1080"), `image` the PNG or JPEG bytes and `thumbnail` a
-- small JPEG for history lists. For images, content_hash is the SHA-256 of the image bytes. size_bytes covers every
-- column, so quotas and the per-entry limit include formatting and images.
ALTER TABLE clipboard_entries ADD COLUMN image BLOB;
ALTER TABLE clipboard_entries ADD COLUMN image_type TEXT CHECK (image_type IS NULL OR image_type IN ('image/png', 'image/jpeg'));
ALTER TABLE clipboard_entries ADD COLUMN thumbnail BLOB;
