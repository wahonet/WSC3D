export const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`

/** '2026-09-02T00:07:09' -> '09-02 00:07' */
export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return ''
  const m = iso.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : iso.replace('T', ' ')
}

export const fmtValue = (value: number | null, unit: string, atype: string) => {
  if (value == null) return ''
  if (atype === 'align') return `RMSE ${value.toFixed(1)} px`
  if (unit === 'px') return `${value.toFixed(1)} px（原图）`
  if (unit === 'model_unit') return `${value.toFixed(3)} 模型单位（未标定）`
  return `${value.toFixed(1)} ${unit}`
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
