// The shapes Columns.vue draws: the series (what each stacked part is, and its colour) and the
// columns (a day or a week, with a count per series).
export type Series = { key: string; label: string; color: string }
/** `short` goes under the column, `long` heads its tooltip; `values` follow the series' order. */
export type Column = { day: string; short: string; long: string; values: number[] }
