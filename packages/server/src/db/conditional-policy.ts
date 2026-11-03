import { newEnforcer, newModel, Util, type Enforcer } from "casbin";
import { PermissionDeniedError, InvalidQueryError } from "@lastsaas/shared";
import { compileRule, type RuleContext } from "./rule-context";

export const CONDITIONAL_MODEL = `
[request_definition]
r = sub, obj, act, next, usr
[policy_definition]
p = sub, obj, act, cond, msg
[role_definition]
g = _, _
[policy_effect]
e = some(where (p.eft == allow))
[matchers]
m = g(r.sub, p.sub) && keyMatch(r.obj.path, p.obj) && (r.act == p.act || p.act == "*") && eval(p.cond)
`;
export interface ConditionalPolicy {
  subject: string;
  resource: string;
  action: string;
  cond: string;
  msg: string;
}

export async function conditionalEnforcer(
  policies: readonly ConditionalPolicy[],
  roles: readonly (readonly [string, string])[],
) {
  const model = newModel();
  model.loadModelFromText(CONDITIONAL_MODEL);
  const enforcer = await newEnforcer(model);
  for (const policy of policies) {
    const rule = compileRule(policy.cond);
    if (policy.resource.includes("/fields/") && rule.usesRecord)
      throw new InvalidQueryError(
        "Field policies cannot depend on record data",
      );
    await enforcer.addPolicy(
      policy.subject,
      policy.resource,
      policy.action,
      policy.cond,
      policy.msg,
    );
  }
  for (const [subject, role] of roles)
    await enforcer.addGroupingPolicy(subject, role);
  return enforcer;
}

export async function applicablePolicies(
  enforcer: Enforcer,
  subject: string,
  resource: string,
  action: string,
): Promise<ConditionalPolicy[]> {
  const subjects = new Set([
    subject,
    ...(await enforcer.getImplicitRolesForUser(subject)),
  ]);
  return (await enforcer.getPolicy())
    .filter(
      ([sub, obj, act]) =>
        subjects.has(sub!) &&
        Util.keyMatchFunc(resource, obj!) &&
        (act === action || act === "*"),
    )
    .map(([sub, obj, act, cond, msg]) => ({
      subject: sub!,
      resource: obj!,
      action: act!,
      cond: cond!,
      msg: msg!,
    }));
}

export async function enforceRuleWrite(
  enforcer: Enforcer,
  subject: string,
  action: string,
  context: RuleContext,
): Promise<void> {
  if (
    await enforcer.enforce(
      subject,
      context.obj,
      action,
      context.next,
      context.usr,
    )
  )
    return;
  const policies = await applicablePolicies(
    enforcer,
    subject,
    context.obj.path,
    action,
  );
  const messages = [
    ...new Set(policies.map((policy) => policy.msg).filter(Boolean)),
  ];
  throw new PermissionDeniedError(
    messages.length ? messages.join("; ") : "Permission denied",
  );
}

export async function allowedRuleRows(
  enforcer: Enforcer,
  subject: string,
  action: string,
  contexts: readonly RuleContext[],
): Promise<boolean[]> {
  return enforcer.batchEnforce(
    contexts.map((context) => [
      subject,
      context.obj,
      action,
      context.next,
      context.usr,
    ]),
  );
}
