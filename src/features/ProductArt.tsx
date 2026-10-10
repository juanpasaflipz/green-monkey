// The art box of a selling-grid tile (kiosk 039, §2.9): the product's initials, and its photo on
// top when this device shows grid photos. The box has a fixed size from CSS whatever the photo
// (no layout shift); the photo loads lazily, is decorative (the tile's text names the product),
// and one that fails to load is dropped, leaving the initials: selling never waits on a photo.
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Locale, Product } from "../../shared/domain";
import { mediaUrl } from "../../shared/media";

export function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
}

export function ProductArt({
  product,
  locale,
  index,
  photos,
}: {
  product: Pick<Product, "name" | "image">;
  locale: Locale;
  index: number;
  photos: boolean;
}) {
  const image = product.image;
  const [failed, setFailed] = useState<string | null>(null);
  const show = photos && !!image && failed !== image.id;
  return (
    <div className={`product-art art-${index % 4}`} aria-hidden="true">
      <div className="dish-mark">{initials(product.name[locale])}</div>
      {show && (
        <img
          className="product-photo"
          src={mediaUrl(image, "thumb")}
          srcSet={`${mediaUrl(image, "thumb")} 160w, ${mediaUrl(image, "card")} 480w`}
          sizes="(max-width: 720px) 50vw, 240px"
          width={Math.min(160, image.w)}
          height={Math.max(
            1,
            Math.round((image.h * Math.min(160, image.w)) / image.w),
          )}
          loading="lazy"
          decoding="async"
          alt=""
          onError={() => setFailed(image.id)}
        />
      )}
      <span className="add-mark">
        <Plus size={18} />
      </span>
    </div>
  );
}
