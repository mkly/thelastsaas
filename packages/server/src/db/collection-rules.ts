import {
  collectionValidationsSchema,
  SchemaValidationError,
  InvalidQueryError,
  extractFieldType,
  isMultipleReference,
  type CollectionValidation,
  type Schema,
  type Where,
} from "@lastsaas/shared";
import { compileRule, loadRuleObjects } from "./rule-context";
import { compileWhere, compileAggregate, substitute } from "./query/compile";
import { countRecords, aggregateRecords } from "./records";
import type { UnitOfWork } from "./unit-of-work";

function sampleValues(schema: Schema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([field, definition]) => {
      const type = extractFieldType(definition)!;
      return [
        field,
        isMultipleReference(definition) || type === "attachments"
          ? []
          : ["number", "float", "integer"].includes(type)
            ? 0
            : type === "boolean"
              ? false
              : type === "date"
                ? "2000-01-01"
                : type === "datetime"
                  ? "2000-01-01T00:00:00.000Z"
                  : "validation",
      ];
    }),
  );
}
export function validateCollectionRules(
  rules: unknown,
  schema: Schema,
): CollectionValidation[] {
  const parsed = collectionValidationsSchema.safeParse(rules);
  if (!parsed.success)
    throw new SchemaValidationError(
      parsed.error.issues.map(
        (issue) => `validations.${issue.path.join(".")}: ${issue.code}`,
      ),
    );
  for (const rule of parsed.data) {
    if ("rule" in rule) {
      compileRule(rule.rule, schema);
      continue;
    }
    const query = "count" in rule ? rule.count : rule.sum;
    const where = query.where
      ? substitute(query.where as Where, sampleValues(schema))
      : undefined;
    for (const provider of ["sqlite", "postgresql"] as const) {
      const compiled =
        "count" in rule
          ? compileWhere(where, schema, provider)
          : compileAggregate(
              {
                where,
                metrics: [{ op: "sum", field: rule.sum.field, as: "total" }],
              },
              schema,
              provider,
              "validation",
              "validation",
            );
      if (compiled.postFilters.length)
        throw new InvalidQueryError(
          "Deferred recurrence predicates are unsupported in validation rules",
        );
    }
  }
  return parsed.data;
}

export async function enforceCollectionRules(
  unit: UnitOfWork,
  orgId: string,
  collection: { name: string; schema: Schema; validations: unknown },
  before: Record<string, unknown> | null,
  next: Record<string, unknown>,
  actorId: string,
  recordId?: string,
): Promise<void> {
  const rules = validateCollectionRules(
    collection.validations,
    collection.schema,
  );
  if (!rules.length) return;
  const expressions = rules
    .flatMap((rule) =>
      "rule" in rule
        ? [{ ...rule, compiled: compileRule(rule.rule, collection.schema) }]
        : [],
    )
    .filter((rule) => before !== null || !rule.compiled.usesBefore);
  const failed: CollectionValidation[] = [];
  if (expressions.length) {
    const references = new Set(
      expressions.flatMap((rule) => [...rule.compiled.references]),
    );
    const [obj, proposed] = await loadRuleObjects(
      unit.db,
      orgId,
      collection.schema,
      [before ?? {}, next],
      references,
    );
    const caller = await unit.db.user.findUnique({
      where: { id: actorId },
      select: { email: true },
    });
    const context = {
      obj: { ...obj!, path: `/collections/${collection.name}` },
      next: proposed!,
      usr: { id: actorId, email: caller?.email ?? "", org: orgId },
    };
    failed.push(
      ...expressions.filter((rule) => !rule.compiled.evaluate(context)),
    );
  }
  const values = Object.fromEntries(
    Object.keys(collection.schema).map((field) => [field, next[field] ?? null]),
  );
  for (const rule of rules) {
    if ("rule" in rule) continue;
    let result: number;
    try {
      const query = "count" in rule ? rule.count : rule.sum;
      const predicate = query.where
        ? substitute(query.where as Where, values)
        : {};
      const where: Where = recordId
        ? { and: [predicate, { id: { not: recordId } }] }
        : predicate;
      if ("count" in rule)
        result = await countRecords(unit, orgId, collection.name, where);
      else {
        const rows = await aggregateRecords(unit, orgId, collection.name, {
          where,
          metrics: [{ op: "sum", field: rule.sum.field, as: "total" }],
        });
        result =
          Number(rows.rows[0]?.total ?? 0) + Number(next[rule.sum.field] ?? 0);
      }
    } catch (error) {
      if (!(error instanceof InvalidQueryError)) throw error;
      failed.push(rule);
      continue;
    }
    if (
      !Number.isFinite(result) ||
      (rule.min !== undefined && result < rule.min) ||
      (rule.max !== undefined && result > rule.max)
    )
      failed.push(rule);
  }
  if (failed.length)
    throw new SchemaValidationError(
      failed.map((rule) => rule.message),
      failed.map((rule) => ({
        path: ["validations", rule.name],
        code: "custom",
      })),
    );
}
