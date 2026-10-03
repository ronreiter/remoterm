import { describe, it, expect } from 'vitest'
import { toSessionMetas } from './sessionMeta'

describe('toSessionMetas', () => {
  it('maps persisted sessions to agent metadata', () => {
    const metas = toSessionMetas(
      {
        sessions: [
          { id: 'a', name: 'API', status: 'open', workDir: '/Users/x/api', colorLabel: 'red', folderId: 'f1', createdAt: '' },
          { id: 'b', name: 'Web', status: 'closed', createdAt: '' }
        ],
        folders: [{ id: 'f1', name: 'Work', expanded: true }]
      },
      { codingTool: 'claude' }
    )
    expect(metas).toEqual([
      { id: 'a', name: 'API', tool: 'claude', cwd: '/Users/x/api', folder: 'Work', color: 'red' },
      { id: 'b', name: 'Web', tool: 'claude', cwd: '', folder: null, color: null }
    ])
  })

  it('tolerates missing / malformed data', () => {
    expect(toSessionMetas(null, null)).toEqual([])
    expect(toSessionMetas({}, {})).toEqual([])
    expect(toSessionMetas({ sessions: [{ id: 'z' }] }, {})).toEqual([
      { id: 'z', name: 'z', tool: 'claude', cwd: '', folder: null, color: null }
    ])
  })
})
