import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenAI } from '@google/genai'

// Vertex AI の Nano Banana 2 Lite（DocuNavi の画像生成ジョブと同じモデル。jobs/image-gen/main.py）
export const MODEL = 'gemini-3.1-flash-lite-image'

const here = path.dirname(fileURLToPath(import.meta.url))
export const OUTPUT_DIR = path.resolve(here, '../../frontend/public/images/menu')

// Vertex AI を、ADC（gcloud auth application-default login）で呼ぶ。API キーは使わない。
// 課金先は GOOGLE_CLOUD_PROJECT。gcloud の既定のプロジェクトは使わない（本番の課金に混ざらないよう、必ず明示する）。
export function createClient(): GoogleGenAI {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  if (!project) {
    console.error('GOOGLE_CLOUD_PROJECT が未設定です。画像生成用（本番と課金を分けた）プロジェクトを指定してください（README）。')
    process.exit(1)
  }
  return new GoogleGenAI({ vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global' })
}

// モデルは PNG と JPEG のどちらでも返しうる。拡張子は返ってきた形式に合わせる。
export function extensionFor(mimeType: string | undefined): string | null {
  if (mimeType === 'image/png') return '.png'
  if (mimeType === 'image/jpeg') return '.jpg'
  return null
}

// 画像の寸法（幅x高さ）。PNG と JPEG のヘッダーだけを見る。
export function imageDimensions(buf: Buffer): string | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1] ?? 0
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}
