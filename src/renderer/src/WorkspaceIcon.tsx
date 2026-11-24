const paths = {
  tasks: 'M3 4.5h10M3 8h10M3 11.5h7',
  agent: 'M2.5 3h11v10h-11zM6 3v10',
  doc: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8h4M6 10.5h4',
  folder: 'M2.5 4h4l1.5 1.5h5.5v7h-11z',
  clock: 'M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM8 5v3l2 1',
  search: 'M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM9.5 9.5l4 4',
  chat: 'M2.5 3.5h11v7H8l-3 2v-2H2.5zM5 6h6M5 8h4',
  flow: 'M5 8h3m3-4H8v8h3M2 6.5h3v3H2zM11 2.5h3v3h-3zM11 10.5h3v3h-3z',
  archive: 'M3 6v7h10V6M2 3h12v3H2zM6 9h4',
  pin: 'm9 2 5 5-2 1-1.5 4-2.5-2.5L4 14l3.5-4L5 7.5 9 6z',
  restore: 'M5.5 4 2.5 7l3 3M2.5 7h6.75a3.5 3.5 0 0 1 0 7H8',
  download: 'M8 2.5v7m-3-3 3 3 3-3M3 10v3h10v-3',
  settings: 'M6.5 2h3l.5 2 2 .5 1.5 2.5-1.5 1.5.5 2.5-2 1.5-2-.8-2 .8-2-1.5.5-2.5L3.5 7 5 4.5 6 4zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  check: 'm3 8 3 3 7-7', more: 'M4 8h.1m3.9 0h.1m3.9 0h.1'
}
export type WorkspaceGlyph = keyof typeof paths
export function WorkspaceIcon({ name }: { name: WorkspaceGlyph }) {
  return <svg className="workspace-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
