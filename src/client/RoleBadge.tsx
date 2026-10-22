/** Fixed, local SVG artwork: role strings are text only, never SVG/HTML input. */
const ICONS: Record<string, string> = {
  general: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  fork: 'M6 3v12a4 4 0 0 0 4 4h8M6 9h8a4 4 0 0 0 4-4V3M15 16l3 3-3 3',
  worker: 'm14 6 4-4 4 4-4 4M14 6 4 16a3 3 0 0 0 4 4L18 10M3 3l5 1 1 5-5-1-1-5ZM9 9l3 3',
  lightworker: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z',
  explorer: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  reviewer: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4ZM7 12l3 3 7-7',
  tester: 'M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10M10 18l1 1 3-3',
  debugger:
    'M8 8h8v8a4 4 0 0 1-8 0V8ZM9 8V6a3 3 0 0 1 6 0v2M4 10l4 2M20 10l-4 2M3 15h5M16 15h5M4 21l4-3M20 21l-4-3M12 9v10',
  architect: 'M9 3h6v5H9V3ZM2 16h6v5H2v-5ZM16 16h6v5h-6v-5ZM12 8v4M5 16v-4h14v4',
  planner: 'M8 4H5v17h14V4h-3M8 2h8v4H8V2ZM8 11l1 1 2-2M13 11h3M8 17l1 1 2-2M13 17h3',
  researcher: 'M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1ZM12 5v15M5 8h4M15 8h4M5 12h4M15 12h4',
  writer: 'M13 3H4v18h16v-9M9 15l1-4 9-9 3 3-9 9-4 1ZM17 4l3 3M7 18h9',
  security: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4ZM8 11h8v6H8v-6ZM10 11V9a2 2 0 0 1 4 0v2',
  designer: 'M3 5h18v14H3V5ZM3 9h18M9 9v10M6 7h1M11 12h7M11 15h4',
  analyst: 'M3 3v18h18M7 17v-5M12 17V8M17 17V4',
  devops: 'M3 3h18v7H3V3ZM3 14h18v7H3v-7ZM6 6h1M6 17h1M14 6h4M14 17h4M12 10v4',
  optimizer: 'M4 19a10 10 0 1 1 16 0M12 14l5-7M7 9l-1-1M12 6V4M4 14H2M20 14h2M10 15a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z',
  translator: 'M2 5h12M8 2v3M4 5c1 5 4 8 9 10M12 5c-1 5-4 8-9 10M13 21l4-11 5 11M15 17h5',
}

/** Exact aliases only: avoid guessing from arbitrary custom role names. */
const ALIASES: Record<string, string> = {
  coder: 'worker',
  developer: 'worker',
  implementer: 'worker',
  qa: 'tester',
  testing: 'tester',
  debug: 'debugger',
  planning: 'planner',
  research: 'researcher',
  docs: 'writer',
  documentation: 'writer',
  auditor: 'security',
  'security-auditor': 'security',
  design: 'designer',
  analysis: 'analyst',
  sre: 'devops',
  performance: 'optimizer',
  localization: 'translator',
}
const CUSTOM_ICON = 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 12h8M12 8v8'

/** Human-readable role badge; unknown/custom roles use a neutral preset. */
export function RoleBadge({ roleId }: { readonly roleId: string }) {
  const preset = Object.hasOwn(ALIASES, roleId) ? ALIASES[roleId]! : roleId
  return (
    <span
      className="dshrs-role-badge"
      title={roleId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
        minWidth: 0,
        padding: '1px 5px',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        borderRadius: 5,
        fontSize: 11,
        lineHeight: '16px',
        verticalAlign: 'middle',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={{ flexShrink: 0 }}
      >
        <path d={Object.hasOwn(ICONS, preset) ? ICONS[preset] : CUSTOM_ICON} />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{roleId}</span>
    </span>
  )
}
