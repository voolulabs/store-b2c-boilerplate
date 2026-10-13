import { loadEnv, Modules, defineConfig } from '@medusajs/utils';
import {
  ADMIN_CORS,
  AUTH_CORS,
  BACKEND_URL,
  COOKIE_SECRET,
  DATABASE_URL,
  JWT_SECRET,
  REDIS_URL,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  POS_PAYMENTS_MANUAL,
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  POS_PAYMENTS_MP_TEST,
  SHOULD_DISABLE_ADMIN,
  STORE_CORS,
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  WORKER_MODE,
  S3_FILE_URL,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_REGION,
  S3_BUCKET,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  S3_ACL,
  MEILISEARCH_HOST,
  MEILISEARCH_ADMIN_KEY
} from 'lib/constants';

loadEnv(process.env.NODE_ENV, process.cwd());

const S3_REQUIRED_VARS = { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_FILE_URL };
const S3_ENABLED = Object.values(S3_REQUIRED_VARS).every(Boolean);
if (!S3_ENABLED && (S3_ENDPOINT || Object.values(S3_REQUIRED_VARS).some(Boolean))) {
  const missing = Object.entries(S3_REQUIRED_VARS).filter(([, value]) => !value).map(([name]) => name);
  console.warn(`S3 file storage is only partially configured - missing: ${missing.join(', ')}. Falling back to local file storage, which is ephemeral on Railway!`);
}

const MEILISEARCH_ENABLED = Boolean(MEILISEARCH_HOST && MEILISEARCH_ADMIN_KEY);

const medusaConfig = {
  projectConfig: {
    databaseUrl: DATABASE_URL,
    databaseLogging: false,
    redisUrl: REDIS_URL,
    workerMode: WORKER_MODE,
    http: {
      adminCors: ADMIN_CORS,
      authCors: AUTH_CORS,
      storeCors: STORE_CORS,
      jwtSecret: JWT_SECRET,
      cookieSecret: COOKIE_SECRET
    },
    build: {
      rollupOptions: {
        external: ["@medusajs/dashboard", "@medusajs/admin-shared"]
      }
    }
  },
  admin: {
    backendUrl: BACKEND_URL,
    disable: SHOULD_DISABLE_ADMIN,
  },
  modules: [
    {
      key: Modules.FILE,
      resolve: '@medusajs/file',
      options: {
        providers: [
          ...(S3_ENABLED ? [{
            resolve: '@medusajs/file-s3',
            id: 's3',
            options: {
              file_url: S3_FILE_URL,
              access_key_id: S3_ACCESS_KEY_ID,
              secret_access_key: S3_SECRET_ACCESS_KEY,
              region: S3_REGION,
              bucket: S3_BUCKET,
              endpoint: S3_ENDPOINT,
              // false omits ACL headers - required by providers without ACL support
              // (Railway buckets, Cloudflare R2, new AWS buckets); public read access
              // is expected to come from a bucket policy in that case.
              acl: S3_ACL,
              download_file_duration: 24 * 60 * 60,
              additional_client_config: {
                forcePathStyle: S3_FORCE_PATH_STYLE
              }
            }
          }] : [{
            resolve: '@medusajs/file-local',
            id: 'local',
            options: {
              upload_dir: 'static',
              backend_url: `${BACKEND_URL}/static`
            }
          }])
        ]
      }
    },
    ...(REDIS_URL ? [{
      key: Modules.EVENT_BUS,
      resolve: '@medusajs/event-bus-redis',
      options: {
        redisUrl: REDIS_URL
      }
    },
    {
      key: Modules.WORKFLOW_ENGINE,
      resolve: '@medusajs/workflow-engine-redis',
      options: {
        redis: {
          redisUrl: REDIS_URL,
        }
      }
    }] : []),
    ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL || RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
      key: Modules.NOTIFICATION,
      resolve: '@medusajs/notification',
      options: {
        providers: [
          ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL ? [{
            resolve: '@medusajs/notification-sendgrid',
            id: 'sendgrid',
            options: {
              channels: ['email'],
              api_key: SENDGRID_API_KEY,
              from: SENDGRID_FROM_EMAIL,
            }
          }] : []),
          ...(RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
            resolve: './src/modules/email-notifications',
            id: 'resend',
            options: {
              channels: ['email'],
              api_key: RESEND_API_KEY,
              from: RESEND_FROM_EMAIL,
            },
          }] : []),
        ]
      }
    }] : []),
    // PAYMENT sempre registrado: collection -> session -> capture dependem dele
    // mesmo sem adquirente (pp_system_default e a rede de seguranca do app de caixa).
    {
      key: Modules.PAYMENT,
      resolve: '@medusajs/payment',
      options: {
        providers: [
          ...(STRIPE_API_KEY && STRIPE_WEBHOOK_SECRET ? [{
            resolve: '@medusajs/payment-stripe',
            id: 'stripe',
            options: {
              apiKey: STRIPE_API_KEY,
              webhookSecret: STRIPE_WEBHOOK_SECRET,
            },
          }] : []),
          // Fase 1 - terminal-presente: um registro por
          // metodo; transfer existe para o handoff de transferencia nao degradar
          // silenciosamente para pp_system_default. O app envia o id verbatim e
          // o Medusa monta pp_pos-terminal_<id>.
          ...(POS_PAYMENTS_MANUAL ? ['card', 'pix', 'cash', 'transfer'].map((method) => ({
            resolve: '@voolulabs/medusajs-plugin-pos-payments/providers/pos-terminal',
            id: method,
            options: { acquirer: 'manual' },
          })) : []),
          // Fase 2 - Mercado Pago Point. Só sobe com flag
          // de teste explícita; mpPointTestMode=true aceita serial SBX* (guard
          // T6 fail-closed no adapter — default é recusar).
          ...(POS_PAYMENTS_MP_TEST ? [{
            resolve: '@voolulabs/medusajs-plugin-pos-payments/providers/pos-terminal',
            id: 'mercadopago',
            options: {
              acquirer: 'mercadopago',
              accessToken: MP_ACCESS_TOKEN,
              webhookSecret: MP_WEBHOOK_SECRET,
              mpPointTestMode: true,
            },
          }] : []),
        ],
      },
    },
    // Medusa 2.19 introduced its own Search Module, and it owns the indexing:
    // it creates and migrates the indexes, seeds them, and keeps them current
    // from catalog events. The Meilisearch plugin is only the engine behind it.
    // Nothing here declares what an index holds - that lives in src/search.
    ...(MEILISEARCH_ENABLED ? [{
      key: Modules.SEARCH,
      resolve: '@medusajs/medusa/search',
      options: {
        providers: [
          {
            resolve: '@rokmohar/medusa-plugin-meilisearch/providers/meilisearch',
            id: 'meilisearch',
            options: {
              config: {
                host: MEILISEARCH_HOST,
                apiKey: MEILISEARCH_ADMIN_KEY
              }
            }
          }
        ]
      }
    }] : [])
  ],
  plugins: [
    // Registered for its API routes and admin settings page only. The search
    // configuration itself belongs to the Search Module above.
    ...(MEILISEARCH_ENABLED ? [{
      resolve: '@rokmohar/medusa-plugin-meilisearch',
      options: {}
    }] : []),
    {
      resolve: '@narisolutions/medusa-plugin-pos',
      options: {
        defaultCurrencyCode: 'brl',
      },
    },
    // §6.4 registro duplo (obrigatorio): as rotas /admin/pos-payments/* so
    // carregam pelo array plugins; o resolve em modules carrega apenas o provider.
    {
      resolve: '@voolulabs/medusajs-plugin-pos-payments',
      options: {
        // Espelho das options do provider (§6.3/T5): alimentam as rotas admin
        // de charges e o subscriber de reconciliacao do webhook. Sem a flag de
        // teste o plugin carrega vazio (rotas respondem NOT_ALLOWED).
        ...(POS_PAYMENTS_MP_TEST ? {
          posTerminal: {
            acquirer: 'mercadopago',
            accessToken: MP_ACCESS_TOKEN,
            webhookSecret: MP_WEBHOOK_SECRET,
            mpPointTestMode: true,
          },
        } : {}),
      },
    },
  ]
};

export default defineConfig(medusaConfig);
