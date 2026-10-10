import { LoaderCircle } from 'lucide-react'

/** 按需载入的页面在代码与数据到达前的统一占位：居中、跟随深浅主题。 */
export default function PageLoading({ label }: { label: string }) {
  return <div className="page-loading" role="status">
    <LoaderCircle size={22} className="page-loading-spin" aria-hidden="true" />
    <span>{label}</span>
  </div>
}
