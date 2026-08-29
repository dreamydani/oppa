import type { ReactElement, ReactNode, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

function BaseSvg({
  size = 16,
  strokeWidth = 1.5,
  children,
  className,
  ...props
}: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export function PanelLeftIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </BaseSvg>
  );
}

export function PanelRightIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </BaseSvg>
  );
}

export function TerminalIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </BaseSvg>
  );
}

export function FolderIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </BaseSvg>
  );
}

export function FileIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </BaseSvg>
  );
}

export function SettingsIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </BaseSvg>
  );
}

export function HelpIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </BaseSvg>
  );
}

export const HelpCircleIcon = HelpIcon;

export function PlusIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </BaseSvg>
  );
}

export function SearchIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </BaseSvg>
  );
}

export function CloseIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </BaseSvg>
  );
}

export function MinimizeIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </BaseSvg>
  );
}

export function MaximizeIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <rect width="14" height="14" x="5" y="5" rx="1" />
    </BaseSvg>
  );
}

export function RestoreIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <rect width="10" height="10" x="8" y="4" rx="1" />
      <path d="M4 8v10a1 1 0 0 0 1 1h10" />
    </BaseSvg>
  );
}

export function SplitSquareIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <line x1="12" x2="12" y1="3" y2="21" />
    </BaseSvg>
  );
}

export function WorktreeForkIcon(props: IconProps): ReactElement {
  return (
    <BaseSvg size={13} strokeWidth={1.5} {...props}>
      <circle cx="5" cy="12" r="2" />
      <path d="M7 12h3.5l4.5-5h4" />
      <path d="M10.5 12l4.5 5h4" />
      <circle cx="19" cy="7" r="1.5" />
      <circle cx="19" cy="17" r="1.5" />
    </BaseSvg>
  );
}


