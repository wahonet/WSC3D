export const publicSections = [
  ['overview', '总览'], ['archive', '文物档案'], ['scene', '院落全景'],
  ['graph', '知识图谱'], ['search', 'AI问答'], ['creative', '电子文创'],
] as const
export const workspaceSections = [['research', '图像研究'], ['library', '文献中心'], ['video', '电子文创'], ['settings', 'API配置']] as const
export type PublicSection = typeof publicSections[number][0]
export type WorkspaceSection = typeof workspaceSections[number][0]
export type SectionId = PublicSection | WorkspaceSection | 'login'

export function isWorkspaceSection(value: string | null): value is WorkspaceSection {
  return workspaceSections.some(([key]) => key === value)
}
export function resolveSection(value: string | null): SectionId {
  if (value === 'graph-explore') return 'graph'
  return value === 'login' || isWorkspaceSection(value) || publicSections.some(([key]) => key === value)
    ? value as SectionId : 'overview'
}
export const VIDEO_POLICY = Object.freeze({ model: 'MiniMax-H3', duration: 5, maxDuration: 6, resolution: '768P', outputs: 1, autoGenerate: false })
