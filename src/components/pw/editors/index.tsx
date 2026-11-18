'use client'

// Registry of custom editors that replace the generic options UI for
// specific tools. The Workspace looks tools up here by `editor` key.

import type { ComponentType } from 'react'
import type { CustomEditor, EditorProps } from '@/lib/pw/types'
import OrganizeGrid from './OrganizeGrid'
import CropEditor from './CropEditor'
import SignEditor from './SignEditor'
import PageEditor from './PageEditor'
import RedactEditor from './RedactEditor'
import ScanCapture from './ScanCapture'
import CompareView from './CompareView'

export const CUSTOM_EDITORS: Record<CustomEditor, ComponentType<EditorProps>> = {
  organize: OrganizeGrid,
  crop: CropEditor,
  sign: SignEditor,
  edit: PageEditor,
  redact: RedactEditor,
  scan: ScanCapture,
  compare: CompareView,
}

export default CUSTOM_EDITORS
