// النخبة QB — wordmark: Amiri "النخبة" + registration-mark glyph.
// The registration mark (the printed corner target on OMR sheets) is the
// only decorative vocabulary this product uses.

export function RegistrationMark({ className = 'h-6 w-6', stroke = 'currentColor' }: { className?: string; stroke?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      {/* corner targets, like the ones printed on an OMR sheet */}
      <circle cx="5" cy="5" r="3" stroke={stroke} strokeWidth="1.5" />
      <circle cx="5" cy="5" r="1" fill={stroke} />
      <circle cx="19" cy="5" r="3" stroke={stroke} strokeWidth="1.5" />
      <circle cx="19" cy="5" r="1" fill={stroke} />
      <circle cx="5" cy="19" r="3" stroke={stroke} strokeWidth="1.5" />
      <circle cx="5" cy="19" r="1" fill={stroke} />
      <circle cx="19" cy="19" r="3" stroke={stroke} strokeWidth="1.5" />
      <circle cx="19" cy="19" r="1" fill={stroke} />
    </svg>
  );
}

export function Wordmark({ onDesk = false }: { onDesk?: boolean }) {
  return (
    <span className="flex items-center gap-2" aria-label="النخبة QB">
      <RegistrationMark
        className="h-6 w-6 shrink-0"
        stroke={onDesk ? 'var(--brass)' : 'var(--sidebar-foreground)'}
      />
      <span className="font-print text-xl font-bold leading-none">النخبة</span>
    </span>
  );
}
