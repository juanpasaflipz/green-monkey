// Menú e inventario → product → "Foto" (039, §2.9; LD-88, LD-91). The browser checks the picked
// file (JPG, PNG or WebP by its bytes, 10 MB, 40 megapixels from its header, before decoding),
// then re-encodes three variants on a canvas (160, 480 and 1200 px wide, never enlarged; a canvas
// carries no EXIF or GPS) and uploads them as one body: WebP, or JPEG where the browser cannot
// encode WebP (desktop Safari and every iPadOS and iOS browser, KIOSK-UX-11). The server validates
// and rebuilds each container (shared/webp.ts, shared/jpeg.ts).
import { useRef, useState } from "react";
import type { Locale, Product } from "../../../shared/domain";
import {
  MEDIA_LIMITS,
  MEDIA_VARIANTS,
  checkOriginal,
  mediaUrl,
  variantSize,
} from "../../../shared/media";
import { strings, translateError } from "../../i18n";
import { api } from "../../api";
import { Button } from "../../components/ui";

type Result = { productId: string; version: number; image: Product["image"] };

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((r) => canvas.toBlob(r, type, MEDIA_LIMITS.quality));

/**
 * The original checked by its bytes, then the three variants as one upload body: all WebP, or all
 * JPEG when the browser hands back something else for WebP (a canvas that cannot encode a type
 * returns PNG; the first variant decides, so one upload never mixes types).
 */
export async function encodePhoto(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const problem = checkOriginal(head, file.size);
  if (problem) throw new Error(problem);
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const parts: Blob[] = [];
  let type = "image/webp";
  try {
    for (const v of MEDIA_VARIANTS) {
      const { w, h } = variantSize(
        { w: bitmap.width, h: bitmap.height },
        v.width,
      );
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d")!;
      g.drawImage(bitmap, 0, 0, w, h);
      // JPEG has no alpha and a canvas flattens it onto black: a transparent PNG gets white.
      const flatten = () => {
        g.globalCompositeOperation = "destination-over";
        g.fillStyle = "#fff";
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = "source-over";
      };
      if (type === "image/jpeg") flatten();
      let blob = await toBlob(canvas, type);
      if (!parts.length && blob?.type !== type) {
        type = "image/jpeg";
        flatten();
        blob = await toBlob(canvas, type);
      }
      if (!blob || blob.type !== type)
        throw new Error("media_encode_unsupported");
      parts.push(blob);
    }
  } finally {
    bitmap.close();
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

export function ProductPhotoField({
  product,
  locale,
  disabled,
  onChanged,
}: {
  product: Product;
  locale: Locale;
  disabled: boolean;
  onChanged: (r: Result) => void;
}) {
  const t = strings[locale];
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const message = (code: string) =>
    code === "media_type_unsupported"
      ? t.menuPhotoTypeError
      : code === "media_too_large"
        ? t.menuPhotoTooLarge
        : code === "media_unavailable"
          ? t.menuPhotoStoreDown
          : code === "media_encode_unsupported"
            ? t.menuPhotoBrowser
            : translateError(code, locale);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const body = await encodePhoto(file);
      const r = await api<Result>(
        `/menu/products/${product.id}/image`,
        {},
        {
          raw: { body, type: "application/octet-stream" },
          headers: { "x-gm-operation-id": crypto.randomUUID() },
          timeoutMs: 60_000,
        },
      );
      onChanged(r);
    } catch (e) {
      setError(message((e as Error).message));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      onChanged(
        await api<Result>(`/menu/products/${product.id}/image/remove`, {
          operationId: crypto.randomUUID(),
          expectedVersion: product.version,
        }),
      );
    } catch (e) {
      setError(message((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const image = product.image;
  return (
    <div className="menu-photo">
      {image ? (
        <img
          className="menu-photo-preview"
          src={mediaUrl(image, "card")}
          width={Math.min(480, image.w)}
          height={Math.round((image.h * Math.min(480, image.w)) / image.w)}
          alt={product.name[locale]}
        />
      ) : null}
      <p className="muted">{t.menuPhotoHint}</p>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label={image ? t.menuPhotoChange : t.menuPhotoUpload}
        disabled={disabled || busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <div className="row wrap">
        <Button
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
        >
          {image ? t.menuPhotoChange : t.menuPhotoUpload}
        </Button>
        {image && (
          <Button
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => void remove()}
          >
            {t.menuPhotoRemove}
          </Button>
        )}
      </div>
      {busy && <p role="status">{t.loading}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
