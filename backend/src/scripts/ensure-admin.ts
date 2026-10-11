import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { createUsersWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Bootstrap idempotente do admin para containers (one-shot do stack de
 * homologação, roda a cada `up`). O `medusa user` do CLI falha quando o
 * usuário já existe — o que bloquearia o `up` seguinte via depends_on — então
 * checamos antes de criar. O registro segue o mesmo fluxo do comando CLI
 * (create-users-workflow + register emailpass + app_metadata.user_id).
 */
export default async function ensureAdmin({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.MEDUSA_ADMIN_EMAIL;
  const password = process.env.MEDUSA_ADMIN_PASSWORD;

  if (!email || !password) {
    logger.warn(
      "ensure-admin: MEDUSA_ADMIN_EMAIL/PASSWORD ausentes — nada a fazer."
    );
    return;
  }

  const userService = container.resolve(Modules.USER);
  const existing = await userService.listUsers({ email });
  if (existing.length > 0) {
    logger.info(`ensure-admin: usuário ${email} já existe — nada a fazer.`);
    return;
  }

  const { result: users } = await createUsersWorkflow(container).run({
    input: { users: [{ email }] },
  });
  const user = users[0];

  const authService = container.resolve(Modules.AUTH);
  const { authIdentity, error } = await authService.register("emailpass", {
    body: { email, password },
  });
  if (error) {
    throw new Error(
      `ensure-admin: registro emailpass falhou para ${email}: ${JSON.stringify(
        error
      )}`
    );
  }

  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { user_id: user.id },
  });

  logger.info(`ensure-admin: usuário ${email} criado.`);
}
