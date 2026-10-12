// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const page = (/** @type {string} */ slug) => ({ slug });

export default defineConfig({
  site: 'https://docs.lynkeus.io',
  integrations: [
    starlight({
      title: 'lynkeus',
      description: 'Automated tests and reports for mobile apps.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: { root: { label: 'English', lang: 'en' }, es: { label: 'Español', lang: 'es' } },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/lynkeushq/lynkeus' }],
      editLink: { baseUrl: 'https://github.com/lynkeushq/lynkeus/edit/main/website/' },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Introduction', translations: { es: 'Introducción' }, slug: '' },
        {
          label: 'Getting started',
          translations: { es: 'Primeros pasos' },
          items: ['getting-started/installation-react-native', 'getting-started/installation-expo', 'getting-started/first-test', 'getting-started/concepts'].map(page),
        },
        {
          label: 'Guides',
          translations: { es: 'Guías' },
          items: [
            'guides/driving-the-app',
            'guides/writing-cases',
            'guides/fixtures',
            'guides/reports',
            'guides/backend-traces',
            'guides/analytics-events',
            'guides/lint-and-contrast',
            'guides/flaky-tests',
            'guides/ai-agents',
            'guides/recording-and-snapshots',
            'guides/ci',
          ].map(page),
        },
        { label: 'Platforms', translations: { es: 'Plataformas' }, items: ['platforms/ios', 'platforms/android', 'platforms/expo', 'platforms/headless'].map(page) },
        {
          label: 'Reference',
          translations: { es: 'Referencia' },
          items: ['reference/cli', 'reference/configuration', 'reference/case-format', 'reference/agent-api', 'reference/environment-variables', 'reference/protocol'].map(page),
        },
        { label: 'Troubleshooting', translations: { es: 'Solución de problemas' }, slug: 'troubleshooting' },
        { label: 'Security', translations: { es: 'Seguridad' }, slug: 'security' },
        { label: 'FAQ', translations: { es: 'Preguntas frecuentes' }, slug: 'faq' },
      ],
    }),
  ],
});
