import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClient, extensionFor, imageDimensions, MODEL, OUTPUT_DIR } from './common.ts'
import { IMAGES } from './prompts.ts'

// Vertex AI の generateContent で、1 枚ずつ生成する（課金される）。実行の前に、枚数と概算費用を示して承認を得る。
const USAGE = `使い方:
  npm run generate -- --id oasis-blend --dry-run   # API を呼ばずに、送る内容だけ表示（課金なし）
  npm run generate -- --id oasis-blend             # 1 枚だけ生成して保存（課金）
  npm run generate -- --all                        # 全件を 1 枚ずつ。保存済みの品は飛ばす（--force で作り直す）。最初の失敗で止まる`

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const idIndex = args.indexOf('--id')
const ids = idIndex >= 0 ? (args[idIndex + 1] ?? '').split(',').filter(Boolean) : []
if (!args.includes('--all') && ids.length === 0) {
  console.error(USAGE)
  process.exit(1)
}
const unknown = ids.filter((id) => !IMAGES.some((img) => img.id === id))
if (unknown.length > 0) {
  console.error(`prompts.ts に無い id: ${unknown.join(', ')}`)
  process.exit(1)
}
const selected = ids.length > 0 ? IMAGES.filter((img) => ids.includes(img.id)) : IMAGES

const savedPath = (outputFileName: string) => {
  const stem = path.join(OUTPUT_DIR, outputFileName.replace(/\.[^.]+$/, ''))
  return ['.jpg', '.png'].map((e) => stem + e).find((p) => existsSync(p))
}

const targets = selected.filter((img) => ids.length > 0 || force || !savedPath(img.outputFileName))
console.log(`model=${MODEL} project=${process.env.GOOGLE_CLOUD_PROJECT ?? '(未設定)'} location=${process.env.GOOGLE_CLOUD_LOCATION ?? 'global'} 枚数=${targets.length}`)
if (dryRun) {
  for (const img of targets) console.log(`- ${img.id}: ${img.aspectRatio}`)
  console.log('[dry-run] API は呼んでいません')
  process.exit(0)
}

const ai = createClient()
mkdirSync(OUTPUT_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const GAP_MS = 15_000 // 呼び出しの間隔（頻度制限の 429 を避ける）
const RETRY_WAIT_MS = 60_000 // 429 のときの待ち。429 は課金されない
const MAX_ATTEMPTS = 4

async function generateWithRetry(img: (typeof IMAGES)[number]) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model: MODEL,
        contents: img.prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: img.aspectRatio } },
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (attempt >= MAX_ATTEMPTS || !/RESOURCE_EXHAUSTED|"code":429/.test(text)) throw error
      console.log(`429（頻度制限）: ${img.id} を ${RETRY_WAIT_MS / 1000} 秒後に再試行（${attempt}/${MAX_ATTEMPTS - 1}）`)
      await sleep(RETRY_WAIT_MS)
    }
  }
}

let failed = 0
let first = true
for (const img of targets) {
  if (!first) await sleep(GAP_MS)
  first = false
  try {
    const response = await generateWithRetry(img)
    const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    const data = part?.inlineData?.data
    if (!data) throw new Error(`画像が返りませんでした（finishReason=${response.candidates?.[0]?.finishReason ?? '-'} blockReason=${response.promptFeedback?.blockReason ?? '-'}）`)
    const ext = extensionFor(part?.inlineData?.mimeType)
    if (!ext) throw new Error(`想定外の形式です: ${part?.inlineData?.mimeType ?? '(不明)'}`)
    // 返ってきた形式の拡張子で保存する（生成済みの画像を捨てない）。PNG が返ると <code>.png になる。
    const target = path.join(OUTPUT_DIR, img.outputFileName.replace(/\.[^.]+$/, '') + ext)
    const bytes = Buffer.from(data, 'base64')
    writeFileSync(target, bytes)
    const usage = response.usageMetadata
    console.log(`保存: ${path.basename(target)} ${bytes.length} bytes 寸法=${imageDimensions(bytes) ?? '不明'}` + (usage ? ` tokens(output=${usage.candidatesTokenCount ?? '-'} total=${usage.totalTokenCount ?? '-'})` : ''))
  } catch (error) {
    failed += 1
    console.error(`失敗: ${img.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`)
    break // 最初の失敗で止める（無駄な呼び出しを増やさない）
  }
}
process.exit(failed > 0 ? 1 : 0)
