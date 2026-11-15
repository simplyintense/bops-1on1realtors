/**
 * Stored listing photos as thumbnails, from the staff media route (never a disk path or a WhatsApp URL). Internal only: there is
 * no download or repost control.
 */
export function PhotoThumbs({ hashes }: { hashes: string[] }) {
  if (!hashes.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {hashes.map((h) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={h} src={`/api/realty/media/${h}/thumb`} alt="Listing photo" loading="lazy" decoding="async" className="h-14 w-14 rounded object-cover" />
      ))}
    </div>
  );
}
