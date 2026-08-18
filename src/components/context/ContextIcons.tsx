import type { ReactElement, SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
}

export function IconSearch({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function IconPlus({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M8 3.5V12.5M3.5 8H12.5" />
    </svg>
  );
}

export function IconArchitecture({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M8 1.75L13.5 4.75L8 7.75L2.5 4.75L8 1.75Z" />
      <path d="M2.5 8.25L8 11.25L13.5 8.25" />
      <path d="M2.5 11.75L8 14.75L13.5 11.75" />
    </svg>
  );
}

export function IconQuirk({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="8" cy="8" r="3.5" />
      <path d="M8 2.5V4.5M8 11.5V13.5M2.5 8H4.5M11.5 8H13.5" />
      <path d="M4.2 4.2L5.6 5.6M10.4 10.4L11.8 11.8M4.2 11.8L5.6 10.4M10.4 5.6L11.8 4.2" />
    </svg>
  );
}

export function IconRunbook({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6.5L7.5 8L5.5 9.5" />
      <path d="M8.5 10.5H10.5" />
    </svg>
  );
}

export function IconPersona({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M3.25 13.5C3.25 10.75 5.25 9.5 8 9.5C10.75 9.5 12.75 10.75 12.75 13.5" />
    </svg>
  );
}

export function IconPreferences({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M2.5 4.5H9.5M12.5 4.5H13.5" />
      <circle cx="11" cy="4.5" r="1.5" />
      <path d="M2.5 11.5H3.5M6.5 11.5H13.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </svg>
  );
}

export function IconStandards({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M8 2L13.5 4.5V8.5C13.5 11.8 11.1 13.8 8 14.5C4.9 13.8 2.5 11.8 2.5 8.5V4.5L8 2Z" />
      <path d="M6 8L7.5 9.5L10.5 6.5" />
    </svg>
  );
}

export function IconPin({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M10.5 2.5L13.5 5.5L11 8L11.5 12L8.5 9L4.5 13L4 12L8 8L5.5 5.5L8 3L10.5 2.5Z" />
    </svg>
  );
}

export function IconEdit({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M11.5 2.5L13.5 4.5L5.5 12.5H3.5V10.5L11.5 2.5Z" />
    </svg>
  );
}

export function IconTrash({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M3 4.5H13" />
      <path d="M5.5 4.5V3C5.5 2.45 5.95 2 6.5 2H9.5C10.05 2 10.5 2.45 10.5 3V4.5" />
      <path d="M4.5 4.5L5.2 13.1C5.25 13.6 5.7 14 6.2 14H9.8C10.3 14 10.75 13.6 10.8 13.1L11.5 4.5" />
    </svg>
  );
}

export function IconFolder({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H6.25L7.75 4H12.5C13.05 4 13.5 4.45 13.5 5V12.5C13.5 13.05 13.05 13.5 12.5 13.5H3.5C2.95 13.5 2.5 13.05 2.5 12.5V3.5Z" />
    </svg>
  );
}

export function IconFile({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M4 2.5H9.5L12.5 5.5V13.5H4V2.5Z" />
      <path d="M9.5 2.5V5.5H12.5" />
    </svg>
  );
}

export function IconBrain({ size = 16, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="8" r="2" />
      <circle cx="19" cy="8" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M6.8 9.2L9.5 10.8M17.2 9.2L14.5 10.8M8.2 16.5L10.2 14.2M15.8 16.5L13.8 14.2" />
      <path d="M5 6V5M19 6V5M12 7V4" />
    </svg>
  );
}

export function IconChevronRight({ size = 12, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

export function IconChevronDown({ size = 12, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M4 6L8 10L12 6" />
    </svg>
  );
}

export function IconTerminal({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 6.5L7 8L5 9.5" />
      <path d="M8.5 10H11" />
    </svg>
  );
}

export function IconGlobe({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <ellipse cx="8" cy="8" rx="2.5" ry="5.5" />
      <path d="M2.5 8H13.5" />
    </svg>
  );
}

export function IconSparkles({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M8 2L9.2 5.8L13 7L9.2 8.2L8 12L6.8 8.2L3 7L6.8 5.8L8 2Z" />
    </svg>
  );
}

export function IconCheck({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
    </svg>
  );
}

export function IconClose({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );
}

export function IconServer({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1.5" />
      <rect x="2" y="9" width="12" height="4.5" rx="1.5" />
      <circle cx="4.5" cy="4.75" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="11.25" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconCopy({ size = 14, className, ...props }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M11 2.5H3.5C2.95 2.5 2.5 2.95 2.5 3.5V11" />
    </svg>
  );
}

