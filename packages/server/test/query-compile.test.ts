import { describe, expect, test } from "bun:test";

import type { AggregateRequest, Schema, Where } from "@lastsaas/shared";

import {
  andWhere,
  applyOrgScope,
  compileAggregate,
  compileOrderBy,
  compileWhere,
  substitute,
  toPgParams,
  validateField,
  type Principal,
} from "../src/db/query/compile";
import { whereSchema } from "../src/db/query/validation";

const schema: Schema = {
  name: "string",
  region: "string",
  amount: "number",
  status: { type: "string", description: "Order status" },
  score: "float",
  count: "integer",
  schedule: "recurrence",
};

describe("compileWhere — flat leaves", () => {
  test("returns empty for null, undefined, and empty input", () => {
    const empty = { sql: "", params: [], postFilters: [] };
    expect(compileWhere(null, schema, "sqlite")).toEqual(empty);
    expect(compileWhere(undefined, schema, "sqlite")).toEqual(empty);
    expect(compileWhere({}, schema, "sqlite")).toEqual(empty);
  });

  test("compiles exact matches for both dialects", () => {
    expect(compileWhere({ name: "Alice" }, schema, "sqlite")).toEqual({
      sql: "json_extract(data, '$.name') = ?",
      params: ["Alice"],
      postFilters: [],
    });
    expect(compileWhere({ name: "Alice" }, schema, "postgresql")).toEqual({
      sql: "data->>'name' = ?",
      params: ["Alice"],
      postFilters: [],
    });
  });

  test("compiles equality and numeric comparisons", () => {
    expect(
      compileWhere({ name: { eq: "Bob" } } as Where, schema, "sqlite"),
    ).toMatchObject({
      sql: "json_extract(data, '$.name') = ?",
      params: ["Bob"],
    });
    expect(
      compileWhere({ amount: { gt: 100 } } as Where, schema, "sqlite").sql,
    ).toBe("CAST(json_extract(data, '$.amount') AS REAL) > ?");
    expect(
      compileWhere({ amount: { gt: 100 } } as Where, schema, "postgresql").sql,
    ).toBe("(data->>'amount')::numeric > ?");
  });

  test("compiles contains with LIKE escaping", () => {
    const result = compileWhere(
      { name: { contains: "%test_" } } as Where,
      schema,
      "sqlite",
    );
    expect(result.params).toEqual(["%\\%test\\_%"]);
    expect(result.sql).toContain("LIKE");
    expect(result.sql).toContain("ESCAPE");
  });

  test("compiles in, empty in, is_null, and between", () => {
    expect(
      compileWhere(
        { status: { in: ["a", "b", "c"] } } as Where,
        schema,
        "sqlite",
      ),
    ).toMatchObject({
      sql: "json_extract(data, '$.status') IN (?, ?, ?)",
      params: ["a", "b", "c"],
    });
    expect(
      compileWhere({ status: { in: [] } } as Where, schema, "sqlite").sql,
    ).toBe("1 = 0");
    expect(
      compileWhere({ name: { is_null: true } } as Where, schema, "sqlite").sql,
    ).toContain("IS NULL");
    expect(
      compileWhere(
        { amount: { between: [10, 50] } } as Where,
        schema,
        "sqlite",
      ),
    ).toMatchObject({
      sql: expect.stringContaining("BETWEEN ? AND ?"),
      params: [10, 50],
    });
  });

  test("rejects unsafe fields and invalid operators", () => {
    expect(() => compileWhere({ bogus: "x" }, schema, "sqlite")).toThrow(
      /Unknown field/,
    );
    expect(() => compileWhere({ "1bad": "x" }, schema, "sqlite")).toThrow(
      /Invalid field/,
    );
    expect(() =>
      compileWhere({ name: { nope: 1 } } as Where, schema, "sqlite"),
    ).toThrow(/Unknown operator/);
  });
});

describe("compileWhere — boolean composition", () => {
  test("compiles and, or, not, and nested composition", () => {
    const andResult = compileWhere(
      { and: [{ name: "A" }, { amount: { gt: 10 } }] } as Where,
      schema,
      "sqlite",
    );
    expect(andResult.sql).toContain(" AND ");
    expect(andResult.params).toEqual(["A", 10]);

    const orResult = compileWhere(
      { or: [{ status: "draft" }, { status: "pending" }] } as Where,
      schema,
      "sqlite",
    );
    expect(orResult.sql).toContain(" OR ");
    expect(orResult.params).toEqual(["draft", "pending"]);

    const notResult = compileWhere(
      { not: { name: "X" } } as Where,
      schema,
      "sqlite",
    );
    expect(notResult.sql).toContain("NOT (");
    expect(notResult.params).toEqual(["X"]);

    const nested = compileWhere(
      {
        and: [{ or: [{ name: "A" }, { name: "B" }] }, { amount: { gte: 5 } }],
      } as Where,
      schema,
      "sqlite",
    );
    expect(nested.sql).toContain("OR");
    expect(nested.sql).toContain("AND");
    expect(nested.params).toHaveLength(3);
  });
});

describe("policy seams", () => {
  test("ANDs an injected predicate into the requested Where tree", () => {
    const result = compileWhere({ name: "Ada" }, schema, "sqlite", {
      extraWhere: { region: "us" },
    });
    expect(result.sql).toContain(" AND ");
    expect(result.params).toEqual(["Ada", "us"]);
  });

  test("calls the allowlist for Where and ordering references", () => {
    const allowed = (field: string) => field !== "status";
    expect(() =>
      compileWhere({ status: "private" }, schema, "sqlite", {
        isFieldAllowed: allowed,
      }),
    ).toThrow(/not allowed in where/);
    expect(() =>
      compileOrderBy("status", schema, "sqlite", {
        isFieldAllowed: allowed,
      }),
    ).toThrow(/not allowed in order by/);
  });

  test("calls the allowlist for group, metric, and having source fields", () => {
    const denyRegion = (field: string) => field !== "region";
    expect(() =>
      compileAggregate(
        { group_by: ["region"], metrics: [{ op: "count" }] },
        schema,
        "sqlite",
        "org",
        "collection",
        { isFieldAllowed: denyRegion },
      ),
    ).toThrow(/not allowed in group by/);

    const denyAmount = (field: string) => field !== "amount";
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "sum", field: "amount", as: "total" }] },
        schema,
        "sqlite",
        "org",
        "collection",
        { isFieldAllowed: denyAmount },
      ),
    ).toThrow(/not allowed in metric/);

    let denyAtHaving = false;
    expect(() =>
      compileAggregate(
        {
          metrics: [{ op: "sum", field: "amount", as: "total" }],
          having: { total: { gt: 10 } },
        },
        schema,
        "sqlite",
        "org",
        "collection",
        {
          isFieldAllowed: (_field, context) =>
            context.kind !== "having" || denyAtHaving,
        },
      ),
    ).toThrow(/not allowed in having/);
    denyAtHaving = true;
  });
});

describe("occurs_between extraction", () => {
  const window = ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"] as [
    string,
    string,
  ];

  test("extracts a descriptor and leaves SQL as a passthrough", () => {
    const result = compileWhere(
      { schedule: { occurs_between: window } } as Where,
      schema,
      "sqlite",
    );
    expect(result).toEqual({
      sql: "",
      params: [],
      postFilters: [
        {
          kind: "occurs_between",
          field: "schedule",
          start: window[0],
          end: window[1],
        },
      ],
    });
  });

  test("keeps safe AND prefilters but widens unsafe OR and NOT expressions", () => {
    const recurrence = { schedule: { occurs_between: window } } as Where;
    const andResult = compileWhere(
      { and: [{ status: "open" }, recurrence] } as Where,
      schema,
      "sqlite",
    );
    expect(andResult.sql).toContain("status");
    expect(andResult.params).toEqual(["open"]);

    const orResult = compileWhere(
      { or: [{ status: "open" }, recurrence] } as Where,
      schema,
      "sqlite",
    );
    expect(orResult.sql).toBe("");
    expect(orResult.params).toEqual([]);

    const notResult = compileWhere(
      { not: recurrence } as Where,
      schema,
      "sqlite",
    );
    expect(notResult.sql).toBe("");
    expect(notResult.postFilters).toHaveLength(1);
  });

  test("rejects use on non-recurrence fields and malformed windows", () => {
    expect(() =>
      compileWhere(
        { name: { occurs_between: window } } as Where,
        schema,
        "sqlite",
      ),
    ).toThrow(/requires a recurrence/);
    expect(() =>
      compileWhere(
        { schedule: { occurs_between: ["only-one"] } } as unknown as Where,
        schema,
        "sqlite",
      ),
    ).toThrow(/\[start, end\]/);
  });
});

describe("compileOrderBy", () => {
  test("defaults to the native created_at DateTime column", () => {
    expect(compileOrderBy(null, schema, "sqlite")).toBe(
      "ORDER BY created_at DESC",
    );
  });

  test("handles native timestamps and JSON schema fields", () => {
    expect(compileOrderBy("-updated_at", schema, "sqlite")).toBe(
      "ORDER BY updated_at DESC",
    );
    expect(compileOrderBy("created_at", schema, "sqlite")).toBe(
      "ORDER BY created_at ASC",
    );
    expect(compileOrderBy("name", schema, "sqlite")).toContain("json_extract");
    expect(compileOrderBy("name", schema, "postgresql")).toContain(
      "data->>'name'",
    );
    expect(() => compileOrderBy("bogus", schema, "sqlite")).toThrow();
  });
});

describe("scope and Where composition", () => {
  test("prepends org and collection scope", () => {
    expect(applyOrgScope("org1", "col1", "amount > ?", [10])).toEqual({
      sql: "org_id = ? AND collection_id = ? AND amount > ?",
      params: ["org1", "col1", 10],
    });
    expect(applyOrgScope("org1", "col1", "", [])).toEqual({
      sql: "org_id = ? AND collection_id = ?",
      params: ["org1", "col1"],
    });
  });

  test("composes optional Where nodes", () => {
    const left: Where = { name: "x" };
    const right = { amount: { gt: 5 } } as Where;
    expect(andWhere(null, null)).toBeUndefined();
    expect(andWhere(left, null)).toBe(left);
    expect(andWhere(null, right)).toBe(right);
    expect(andWhere(left, right)).toEqual({ and: [left, right] });
  });
});

describe("substitute", () => {
  const principal: Principal = {
    userId: "u1",
    userEmail: "a@example.com",
    orgId: "org1",
  };

  test("substitutes the closed principal-variable set", () => {
    expect(substitute({ name: "$user.id" }, principal)).toEqual({ name: "u1" });
    expect(substitute({ name: "$user.email" }, principal)).toEqual({
      name: "a@example.com",
    });
    expect(substitute({ name: "$org.id" }, principal)).toEqual({
      name: "org1",
    });
    expect(substitute({ name: "literal" }, principal)).toEqual({
      name: "literal",
    });
  });

  test("walks nesting and rejects unrecognized variables", () => {
    expect(
      substitute(
        { and: [{ name: "$user.id" }, { region: "$org.id" }] } as Where,
        principal,
      ),
    ).toEqual({ and: [{ name: "u1" }, { region: "org1" }] });
    expect(() => substitute({ name: "$user.password" }, principal)).toThrow(
      /Unknown substitution/,
    );
    expect(() => substitute({ name: "$$" }, principal)).toThrow(
      /Unknown substitution/,
    );
  });
});

describe("parameter and identifier helpers", () => {
  test("converts placeholders for PostgreSQL", () => {
    expect(toPgParams("WHERE a = ? AND b = ? LIMIT ?")).toBe(
      "WHERE a = $1 AND b = $2 LIMIT $3",
    );
  });

  test("validates schema fields", () => {
    expect(() => validateField("name", schema)).not.toThrow();
    expect(() => validateField("nope", schema)).toThrow(/Unknown field/);
    expect(() => validateField("1bad", schema)).toThrow(/Invalid field/);
  });
});

describe("compileAggregate", () => {
  test("compiles count without grouping", () => {
    const request: AggregateRequest = { metrics: [{ op: "count", as: "n" }] };
    const result = compileAggregate(request, schema, "sqlite", "org1", "col1");
    expect(result.sql).toContain("COUNT(*)");
    expect(result.sql).toContain("WITH agg AS");
    expect(result.columns).toEqual(["n"]);
    expect(result.postFilters).toEqual([]);
  });

  test("compiles numeric metrics and grouping for both dialects", () => {
    const grouped = compileAggregate(
      {
        group_by: ["region"],
        metrics: [{ op: "sum", field: "amount", as: "total" }],
      },
      schema,
      "sqlite",
      "org1",
      "col1",
    );
    expect(grouped.sql).toContain("GROUP BY");
    expect(grouped.sql).toContain("SUM(");
    expect(grouped.columns).toEqual(["region", "total"]);

    const postgres = compileAggregate(
      { metrics: [{ op: "sum", field: "amount", as: "total" }] },
      schema,
      "postgresql",
      "org1",
      "col1",
    );
    expect(postgres.sql).toContain("::numeric");
  });

  test("rejects invalid fields, aliases, and metric types", () => {
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "sum", field: "name" }] },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/numeric/);
    expect(() =>
      compileAggregate(
        { group_by: ["bogus"], metrics: [{ op: "count" }] },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/Unknown field/);
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "count", as: 'x"; DROP TABLE records; --' }] },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/Invalid aggregate alias/);
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "count", as: "1bad" }] },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/Invalid aggregate alias/);
  });

  test("compiles having and alias ordering on the outer CTE", () => {
    const result = compileAggregate(
      {
        group_by: ["region"],
        metrics: [{ op: "count", as: "n" }],
        having: { n: { gt: 10 } },
        order_by: "-n",
      },
      schema,
      "sqlite",
      "org1",
      "col1",
    );
    expect(result.sql.split("SELECT * FROM agg")[1]).toContain("WHERE");
    expect(result.sql).toContain('ORDER BY "n" DESC');
  });

  test("rejects undefined having and order aliases and collisions", () => {
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "count", as: "n" }], having: { bogus: { gt: 1 } } },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/not a defined/);
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "count", as: "n" }], order_by: "bogus" },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/not a group_by/);
    expect(() =>
      compileAggregate(
        {
          group_by: ["region"],
          metrics: [{ op: "count", as: "region" }],
        },
        schema,
        "sqlite",
        "org1",
        "col1",
      ),
    ).toThrow(/collides/);
  });

  test("applies scope, requested Where, and injected Where", () => {
    const result = compileAggregate(
      { where: { region: "us" }, metrics: [{ op: "count" }] },
      schema,
      "sqlite",
      "org1",
      "col1",
      { extraWhere: { status: "active" } },
    );
    expect(result.params.slice(0, 4)).toEqual(["org1", "col1", "us", "active"]);
    expect(result.sql).toContain("org_id = ?");
    expect(result.sql).toContain("collection_id = ?");
  });

  test("accepts all numeric schema types and empty in for having", () => {
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "avg", field: "score" }] },
        schema,
        "sqlite",
        "org",
        "collection",
      ),
    ).not.toThrow();
    expect(() =>
      compileAggregate(
        { metrics: [{ op: "min", field: "count" }] },
        schema,
        "sqlite",
        "org",
        "collection",
      ),
    ).not.toThrow();
    expect(
      compileAggregate(
        {
          group_by: ["region"],
          metrics: [{ op: "count", as: "n" }],
          having: { n: { in: [] } },
        },
        schema,
        "sqlite",
        "org",
        "collection",
      ).sql,
    ).toContain("1 = 0");
  });

  test("returns recurrence post-filters for later aggregate expansion", () => {
    const result = compileAggregate(
      {
        where: {
          schedule: {
            occurs_between: ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"],
          },
        } as Where,
        metrics: [{ op: "count" }],
      },
      schema,
      "sqlite",
      "org",
      "collection",
    );
    expect(result.postFilters).toHaveLength(1);
    expect(result.params.slice(0, 2)).toEqual(["org", "collection"]);
  });
});

describe("whereSchema", () => {
  function nestedNot(depth: number): unknown {
    return depth === 0 ? { name: "x" } : { not: nestedNot(depth - 1) };
  }

  test("accepts the full operator vocabulary including occurs_between", () => {
    expect(
      whereSchema.safeParse({
        schedule: {
          occurs_between: ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"],
        },
      }).success,
    ).toBe(true);
  });

  test("enforces the boolean nesting limit", () => {
    expect(whereSchema.safeParse(nestedNot(8)).success).toBe(true);
    expect(whereSchema.safeParse(nestedNot(9)).success).toBe(false);
  });
});
