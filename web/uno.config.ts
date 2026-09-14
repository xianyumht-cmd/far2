import { defineConfig, presetAttributify, presetIcons, presetUno, presetWebFonts } from 'unocss'

export default defineConfig({
  blocklist: [
    'i-carbon-circle-dash-function',
    'i-carbon-circle-dash-string',
    'i-carbon-circle-dash-return',
    'i-carbon-renew-animate-spin',
    'i-carbon-restart-animate-spin',
  ],
  content: {
    pipeline: {
      include: [
        /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
        'src/**/*.{js,ts}',
      ],
    },
  },
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true,
      collections: {
        carbon: () => import('@iconify-json/carbon/icons.json').then(i => i.default),
        fas: () => import('@iconify-json/fa-solid/icons.json').then(i => i.default),
        'svg-spinners': () => import('@iconify-json/svg-spinners/icons.json').then(i => i.default),
      },
    }),
    presetWebFonts({
      fonts: {
        sans: 'DM Sans',
        serif: 'DM Serif Display',
        mono: 'DM Mono',
      },
    }),
  ],
})
