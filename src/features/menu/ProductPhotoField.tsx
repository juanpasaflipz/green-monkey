// Menú e inventario → product → "Foto" (039, §2.9; LD-88). The browser checks the picked file
// (JPG, PNG or WebP by its bytes, 10 MB, 40 megapixels from its header, before decoding), then
// re-encodes three WebP variants on a canvas (160, 480 and 1200 px wide, never enlarged; a canvas
// carries no EXIF or GPS) and uploads them as one body. The server validates and rebuilds each
// WebP container. Browsers that cannot encode WebP on a canvas get a clear message.
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

/** The original checked by its bytes, then the three WebP variants as one upload body. */
export async function encodePhoto(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const problem = checkOriginal(head, file.size);
  if (problem) throw new Error(problem);
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const parts: Blob[] = [];
  try {
    for (const v of MEDIA_VARIANTS) {
      const { w, h } = variantSize(
        { w: bitmap.width, h: bitmap.height },
        v.width,
      );
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/webp", MEDIA_LIMITS.quality),
      );
      if (!blob || blob.type !== "image/webp")
        throw new Error("media_webp_unsupported");
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
          : code === "media_webp_unsupported"
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
          src={mediaUrl(image.id, "card")}
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
