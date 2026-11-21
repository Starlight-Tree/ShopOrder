export type ImageSpec = {
  id: string // メニューの code（backend/app/seed_demo.py の MENU）。保存名も同じ
  purpose: string
  prompt: string
  aspectRatio: '4:3'
  outputFileName: string
}

// 全画像に共通。背景の印象は docs/world.md の「店のトーン」（夕暮れの群青の空・土色の岩場・石造りのガラスドーム・琥珀色の灯り。画像を目で見た所見で、正本の色指定ではない）に合わせる。
// 食材の「見慣れない感じ」は、この画像だけの演出（新設）で、世界観の設定ではない。
const WORLD =
  'Setting: a café on Zahard, an unfamiliar desert planet. A stone-built glass dome; through the window, a dusk ultramarine sky and earth-colored rock formations; warm amber lamplight. ' +
  'The food and drink look real and appetizing, with ingredients that feel slightly unfamiliar and otherworldly (unusual leaf shapes, subtly different colors) yet entirely plausible. ' +
  'Photorealistic product photography with natural textures, shallow depth of field and soft light. 4:3 composition, the product is the clear main subject with space around it. ' +
  'No text, no letters, no logos, no real brands, no people, nothing readable on any surface.'

const spec = (id: string, purpose: string, subject: string): ImageSpec => ({
  id,
  purpose,
  prompt: `${subject} ${WORLD}`,
  aspectRatio: '4:3',
  outputFileName: `${id}.jpg`,
})

export const IMAGES: ImageSpec[] = [
  spec('oasis-blend', 'オアシスブレンド', 'A white ceramic cup of freshly brewed dark-roast coffee with a thin crema on a stone-grey saucer, three small piles of dark roasted beans in three subtly different shades beside it, on a rough sandstone table.'),
  spec('seasonal-blend', '季節のブレンド', 'A ceramic cup of medium-dark coffee on a sandstone table, with a small sprig of an unfamiliar pale-gold desert plant and a few roasted beans beside the saucer, suggesting a seasonal blend.'),
  spec('kikan-limited', '帰還祭の限定ドリンク', 'A tall clear glass of a festive layered drink, deep amber at the bottom fading to cream, topped with a dusting of fine glittering sugar, small warm lights glowing softly behind it as if for a homecoming festival.'),
  spec('cafe-latte', 'カフェラテ', 'A wide ceramic cup of café latte seen from slightly above, creamy microfoam with a simple abstract leaf-shaped latte art, on a sandstone table.'),
  spec('americano', 'アメリカーノ', 'A tall glass of clear dark americano with a few ice cubes catching the amber light, on a sandstone table.'),
  spec('cappuccino', 'カプチーノ', 'A ceramic cup of cappuccino with thick airy milk foam and a light dusting of cocoa, on a saucer with a small spoon.'),
  spec('matcha-latte', '抹茶ラテ', 'A clear glass of iced matcha latte, vivid green blending into white milk, with a bamboo whisk resting beside the glass.'),
  spec('black-tea', '紅茶', 'A clear glass teapot and a cup of black tea, deep red-amber liquid with steam rising, a few loose tea leaves on the table.'),
  spec('hot-sandwich', 'ホットサンド', 'A freshly toasted hot sandwich cut in half on a dark slate plate, melted cheese stretching, golden grill marks.'),
  spec('meat-pie', 'ミートパイ', 'A golden flaky meat pie with one slice cut to show the savory filling, on a dark stone plate with a sprig of herb.'),
  spec('cheesecake', 'チーズケーキ', 'A smooth slice of baked cheesecake on a small plate with a fork and a thin glossy fruit sauce.'),
  spec('gateau-chocolat', 'ガトーショコラ', 'A dense slice of gâteau au chocolat dusted with powdered sugar, a few walnuts beside it, on a stone plate.'),
  spec('morning-set', 'モーニングセット', 'A wooden tray with a small cup of dark coffee and two slices of buttered toast on a plate, in soft dawn light from the dome window.'),
  spec('beans-oasis', 'オアシスブレンドの豆（200 g）', 'A plain matte kraft-paper coffee bag with no printing, standing beside a small wooden scoop of dark roasted beans spilling onto a sandstone table.'),
  spec('beans-seasonal', '季節のブレンドの豆（200 g）', 'A plain matte kraft-paper coffee bag with no printing, standing beside a small wooden scoop of medium-roast beans and a sprig of an unfamiliar pale-gold plant on a sandstone table.'),
]
