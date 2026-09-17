/**
 * Photographs of the goods: content-addressed files on the operator's disk.
 *
 * **Why the image is not on the chain.** CIP-25 and CIP-68 can put NFT metadata
 * into the minting transaction, which would make the description as
 * tamper-evident as the ownership. It costs fees per byte, cannot be corrected
 * after minting, and is unusable for images of any real size -- which is why
 * production marketplaces do what this does and pin the image elsewhere, keeping
 * at most a hash on-chain. The trade-off is the interesting part: permanence and
 * tamper-evidence bought with cost and unfixability. This project chooses the
 * mutable side deliberately, and says so, rather than pretending the operator is
 * not trusted to describe what is in the box.
 *
 * Two properties of the storage scheme are worth stating because both are
 * security-relevant rather than tidiness:
 *
 *   **Content-addressed.** The filename is the SHA-256 of the bytes. So the
 *   client never chooses a path -- no traversal, no collision, no overwriting
 *   someone else's photo by naming it theirs -- and uploading the same image
 *   twice costs one file.
 *
 *   **Sniffed, not declared.** The type comes from the leading bytes, not from
 *   the Content-Type the browser sent. A declared type is a claim by the
 *   uploader; serving a file as whatever it claims to be is how an "image"
 *   upload becomes stored HTML and then stored XSS.
 */

/** Where files land, relative to `off-chain/`. */
const UPLOAD_DIR = "uploads";

/** The path prefix they are served under. */
export const UPLOAD_PREFIX = "/uploads/";

/**
 * 5 MB. Large enough for a phone photograph, small enough that a handful of
 * them cannot fill the disk while nobody is looking.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Formats accepted, by signature. SVG is absent on purpose: it is script. */
const SIGNATURES: { ext: string; type: string; match: (b: Uint8Array) => boolean }[] = [
  {
    ext: "png",
    type: "image/png",
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: "jpg",
    type: "image/jpeg",
    match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    type: "image/gif",
    match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    ext: "webp",
    type: "image/webp",
    // "RIFF" .... "WEBP"
    match: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export const ACCEPTED_IMAGE_TYPES = SIGNATURES.map((s) => s.type);

export class UploadError extends Error {}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Store an image and return the URL it is served at.
 *
 * The SHA-256 is returned alongside because it is the one claim about an image
 * that *could* meaningfully go on-chain, and a reader of the thesis will ask.
 */
export async function saveImage(
  bytes: Uint8Array,
): Promise<{ url: string; sha256: string; type: string }> {
  if (bytes.length === 0) throw new UploadError("That file is empty.");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new UploadError(
      `That image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    );
  }

  const kind = SIGNATURES.find((s) => s.match(bytes));
  if (!kind) {
    throw new UploadError(
      `That file is not a PNG, JPEG, GIF or WebP image. ` +
        `(The check reads the file's own leading bytes, not its name or its declared type.)`,
    );
  }

  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const name = `${sha256}.${kind.ext}`;

  await Deno.mkdir(UPLOAD_DIR, { recursive: true });
  // Same bytes, same name: writing again is a no-op that costs one write.
  await Deno.writeFile(`${UPLOAD_DIR}/${name}`, bytes);

  return { url: `${UPLOAD_PREFIX}${name}`, sha256, type: kind.type };
}

/**
 * Serve a stored image.
 *
 * The filename is validated against the shape `saveImage` produces rather than
 * being passed to the filesystem as given. Content-addressing already removes
 * the client's ability to choose a name, but this path is reachable by anyone
 * with a URL bar, and "the only writer is trusted" is not a reason to hand
 * untrusted input to `Deno.readFile`.
 */
export async function readUpload(pathname: string): Promise<Response | undefined> {
  if (!pathname.startsWith(UPLOAD_PREFIX)) return undefined;
  const name = pathname.slice(UPLOAD_PREFIX.length);

  const m = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/.exec(name);
  if (!m) return undefined;
  const kind = SIGNATURES.find((s) => s.ext === m[2]);
  if (!kind) return undefined;

  try {
    const file = await Deno.readFile(`${UPLOAD_DIR}/${name}`);
    return new Response(file, {
      headers: {
        "content-type": kind.type,
        // The name *is* the hash of the content, so the content at this URL can
        // never change. It is safe to cache for as long as anyone likes.
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return undefined;
  }
}
