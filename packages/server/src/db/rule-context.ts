import { addBinaryOp, compile, parse } from "@casbin/expression-eval";
import { Util } from "casbin";
import {
  InvalidQueryError,
  extractFieldType,
  isMultipleReference,
  type Schema,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";

addBinaryOp("in", 7, Util.customIn);

export interface RuleObject {
  data: Record<string, unknown>;
  refs: Record<string, unknown>;
}
export interface RuleContext {
  obj: RuleObject & { path: string };
  next: RuleObject;
  usr: { id: string; email: string; org: string };
}

/** Inspect the parsed expression, never string literals, for context dependencies. */
export function compileRule(expression: string, schema?: Schema) {
  let evaluate: ReturnType<typeof compile>;
  let tree: ReturnType<typeof parse>;
  try {
    const source = Util.bracketCompatible(expression);
    tree = parse(source);
    evaluate = compile(source);
  } catch {
    throw new InvalidQueryError("Invalid rule expression");
  }
  const references = new Set<string>();
  let usesBefore = false;
  let usesRecord = false;
  function memberPath(value: unknown): string[] | undefined {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "Identifier") return [String(node.name)];
    if (node.type !== "MemberExpression") return;
    const base = memberPath(node.object);
    const property = node.property as Record<string, unknown>;
    const key = node.computed ? property.value : property.name;
    return base && typeof key === "string" ? [...base, key] : undefined;
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "MemberExpression") {
      const base = memberPath(node.object);
      const property = node.property as Record<string, unknown>;
      if (
        base?.[0] === "r" &&
        base[2] === "refs" &&
        node.computed &&
        typeof property.value !== "string"
      )
        throw new InvalidQueryError(
          "Rule reference fields must be literal names",
        );
    }
    const path = memberPath(node);
    if (path?.[0] === "r" && ["obj", "next"].includes(path[1] ?? "")) {
      usesRecord = true;
      if (path[1] === "obj") usesBefore = true;
      if (path[2] === "refs" && path[3]) {
        const field = path[3];
        if (
          schema &&
          (!Object.hasOwn(schema, field) ||
            !extractFieldType(schema[field]!)?.startsWith("ref:"))
        )
          throw new InvalidQueryError(
            `Rule reference '${field}' must name a reference field`,
          );
        references.add(field);
      }
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(tree);
  return {
    expression,
    references,
    usesBefore,
    usesRecord,
    evaluate(context: RuleContext): boolean {
      try {
        return evaluate({ r: context }) === true;
      } catch {
        return false;
      }
    },
  };
}

/** Load all requested targets once per field, scoped to both org and target collection.
 * These full-data snapshots are exclusively for evaluation, never response projection. */
export async function loadRuleObjects(
  db: Prisma.TransactionClient,
  orgId: string,
  schema: Schema,
  records: readonly Record<string, unknown>[],
  references: ReadonlySet<string>,
): Promise<RuleObject[]> {
  const objects = records.map((data) => ({
    data,
    refs: Object.create(null) as Record<string, unknown>,
  }));
  for (const field of references) {
    const definition = schema[field];
    const type = definition && extractFieldType(definition);
    if (!definition || !type?.startsWith("ref:"))
      throw new InvalidQueryError(
        `Rule reference '${field}' must name a reference field`,
      );
    const multiple = isMultipleReference(definition);
    const idsFor = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((id): id is string => typeof id === "string")
          : [];
    const ids = [...new Set(records.flatMap((data) => idsFor(data[field])))];
    const rows = ids.length
      ? await db.record.findMany({
          where: {
            orgId,
            collection: { orgId, name: type.slice(4) },
            id: { in: ids },
          },
          select: { id: true, data: true },
        })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row.data]));
    for (const object of objects) {
      const targets = idsFor(object.data[field]).map(
        (id) => byId.get(id) ?? null,
      );
      object.refs[field] = multiple ? targets : (targets[0] ?? null);
    }
  }
  return objects;
}
