import { RefreshCw } from 'lucide-react';
import { useStore } from '../store';

export default function ScanButton({ stoneId }: { stoneId?: string }) {
  const scanning = useStore(s => s.scanning);
  const active = scanning === (stoneId || 'all');
  return <button className="archive-scan" disabled={!!scanning}
    title={stoneId ? '照片放入该文物文件夹的 images 子目录后，点击扫描新增内容' : '扫描全部已登记文物文件夹的新增照片、拓片及模型'}
    onClick={() => void useStore.getState().rescan(stoneId)}>
    <RefreshCw size={13} className={active ? 'archive-scan-spin' : ''} />
    {active ? '扫描中…' : stoneId ? '重新扫描' : '批量扫描'}
  </button>;
}
