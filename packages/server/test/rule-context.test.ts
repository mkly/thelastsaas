import { jobsFor } from "../src/jobs";
import { registerDatabaseProvider } from "../src/db/provider";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileRule,
  loadRuleObjects,
  type RuleContext,
} from "../src/db/rule-context";
import {
  conditionalEnforcer,
  enforceRuleWrite,
  allowedRuleRows,
} from "../src/db/conditional-policy";
import { testMigrationSql } from "./test-migrations";

const context = (discount = 10): RuleContext => ({
  obj: {
    path: "/collections/quotes",
    data: { status: "draft", owner: "rep" },
    refs: {},
  },
  next: { data: { status: "pending", discount }, refs: {} },
  usr: { id: "rep", email: "rep@example.com", org: "acme" },
});
const condition =
  "r.obj.data.status == 'draft' && r.next.data.status in ('draft', 'pending') && r.next.data.discount <= 10";

test("expression and Casbin eval agree on before/after, membership, and caller attributes", async () => {
  const rule = compileRule(condition);
  expect(rule.usesBefore).toBe(true);
  expect(rule.evaluate(context())).toBe(true);
  expect(rule.evaluate(context(20))).toBe(false);
  const deniedStatus = context();
  deniedStatus.next.data.status = "approved";
  expect(rule.evaluate(deniedStatus)).toBe(false);
  expect(
    compileRule("r.next.data.status in ('draft', 'pending')").evaluate(
      context(),
    ),
  ).toBe(true);
  const enforcer = await conditionalEnforcer(
    [
      {
        subject: "sales",
        resource: "/collections/quotes",
        action: "update",
        cond: condition,
        msg: "Sales discount limit is 10%.",
      },
    ],
    [["rep", "sales"]],
  );
  await enforceRuleWrite(enforcer, "rep", "update", context());
  await expect(
    enforceRuleWrite(enforcer, "rep", "update", deniedStatus),
  ).rejects.toThrow("Sales discount limit");
  await expect(
    enforceRuleWrite(enforcer, "rep", "update", context(20)),
  ).rejects.toThrow("Sales discount limit is 10%.");
  expect(
    await allowedRuleRows(enforcer, "rep", "update", [context(), context(20)]),
  ).toEqual([true, false]);
  expect(compileRule("r.obj.data.owner == r.usr.id").evaluate(context())).toBe(
    true,
  );
});

test("denials report only matching policy messages; roles and additive grants work", async () => {
  const enforcer = await conditionalEnforcer(
    [
      {
        subject: "sales",
        resource: "/collections/quotes",
        action: "update",
        cond: "false",
        msg: "Sales rule",
      },
      {
        subject: "staff",
        resource: "/collections/*",
        action: "*",
        cond: "false",
        msg: "Staff rule",
      },
      {
        subject: "other",
        resource: "/*",
        action: "*",
        cond: "false",
        msg: "Private rule",
      },
      { subject: "admin", resource: "/*", action: "*", cond: "true", msg: "" },
    ],
    [
      ["rep", "sales"],
      ["sales", "staff"],
      ["boss", "admin"],
    ],
  );
  await expect(
    enforceRuleWrite(enforcer, "rep", "update", context()),
  ).rejects.toThrow("Sales rule; Staff rule");
  await expect(
    enforceRuleWrite(enforcer, "stranger", "read", context()),
  ).rejects.toThrow("Permission denied");
  await enforceRuleWrite(enforcer, "boss", "update", context(500));
  await enforcer.addPolicy("rep", "/collections/quotes", "update", "true", "");
  await enforceRuleWrite(enforcer, "rep", "update", context(500));
});

test("expression dependencies come from syntax and invalid definitions fail safely", async () => {
  expect(compileRule("'r.obj.refs.fake' == 'text'").references.size).toBe(0);
  expect(compileRule("'r.obj' == 'text'").usesBefore).toBe(false);
  const rule = compileRule(
    "r.next.refs.customer.max_discount >= r.next.data.discount",
    { customer: "ref:customers" },
  );
  expect([...rule.references]).toEqual(["customer"]);
  expect(rule.evaluate(context())).toBe(false);
  expect(() =>
    compileRule("r.next.refs.customer.limit > 0", { customer: "string" }),
  ).toThrow("reference field");
  expect(() => compileRule("r.next.data. >")).toThrow(
    "Invalid rule expression",
  );
  await expect(
    conditionalEnforcer(
      [
        {
          subject: "sales",
          resource: "/collections/quotes/fields/discount",
          action: "update",
          cond: condition,
          msg: "",
        },
      ],
      [],
    ),
  ).rejects.toThrow("Field policies");
});

test("reference loading batches by field and never crosses organization or target collection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-rule-context-"));
  const path = join(directory, "test.db");
  const sqlite = new Database(path);
  sqlite.exec(testMigrationSql);
  sqlite.close();
  const db = new PrismaClient({
    datasources: { db: { url: `file:${path}` } },
    log: [{ emit: "event", level: "query" }],
  });
  registerDatabaseProvider(db, `file:${path}`);
  let selects = 0;
  db.$on("query", (event) => {
    if (event.query.startsWith("SELECT")) selects++;
  });
  try {
    for (const orgId of ["acme", "foreign"]) {
      await db.organization.create({
        data: { id: orgId, name: orgId, slug: orgId },
      });
      for (const name of ["customers", "other"])
        await db.collection.create({
          data: {
            id: `${orgId}-${name}`,
            orgId,
            name,
            schema: { max_discount: "number" },
          },
        });
    }
    for (const [id, orgId, collectionId] of [
      ["a", "acme", "acme-customers"],
      ["b", "acme", "acme-customers"],
      ["wrong", "acme", "acme-other"],
      ["secret", "foreign", "foreign-customers"],
    ])
      await db.record.create({
        data: {
          id: id!,
          orgId: orgId!,
          collectionId: collectionId!,
          data: { max_discount: 25 },
          createdBy: "test",
        },
      });
    const schema = {
      customer: "ref:customers",
      team: { type: "ref:customers", multiple: true },
    };
    selects = 0;
    const rows = await loadRuleObjects(
      db,
      "acme",
      schema,
      [
        { customer: "a", team: ["b", "a", "secret"] },
        { customer: "wrong", team: [] },
        { customer: "secret" },
      ],
      new Set(["customer", "team"]),
    );
    expect(selects).toBe(2);
    expect(rows[0]?.refs).toEqual({
      customer: { max_discount: 25 },
      team: [{ max_discount: 25 }, { max_discount: 25 }, null],
    });
    expect(rows[1]?.refs.customer).toBeNull();
    expect(rows[2]?.refs.customer).toBeNull();
    selects = 0;
    await loadRuleObjects(db, "acme", schema, [{ customer: "a" }], new Set());
    expect(selects).toBe(0);
    const { collectionReadScope } = await import("../src/db/conditional-read");
    const { queryRecords, countRecords, aggregateRecords } =
      await import("../src/db/records");
    const readPolicy = {
      subject: "rep",
      resource: "/collections/customers",
      action: "read",
      cond: "r.obj.data.max_discount <= 25",
      msg: "",
    };
    const enforcer = await conditionalEnforcer(
      [
        readPolicy,
        {
          ...readPolicy,
          resource: "/collections/customers/fields/max_discount",
          cond: "true",
        },
      ],
      [],
    );
    await db.record.update({
      where: { id: "b" },
      data: { data: { max_discount: 50 } },
    });
    const caller = { id: "rep", email: "rep@example.com", org: "acme" };
    const collection = {
      id: "acme-customers",
      name: "customers",
      schema: { max_discount: "number" },
    };
    const scope = await collectionReadScope(db, enforcer, caller, collection);
    expect(scope.where).toEqual({ id: { in: ["a"] } });
    expect([...scope.readableFields]).toEqual(["max_discount"]);
    expect(await countRecords(db, "acme", "customers", scope.where)).toBe(1);
    expect(
      (
        await queryRecords(
          db,
          "acme",
          "customers",
          scope.where,
          undefined,
          1,
          1,
        )
      ).records,
    ).toEqual([]);
    expect(
      (
        await aggregateRecords(db, "acme", "customers", {
          where: scope.where,
          metrics: [{ op: "sum", field: "max_discount", as: "total" }],
        })
      ).rows,
    ).toEqual([{ total: 25 }]);
    const large = {
      id: {
        in: [
          "a",
          ...Array.from({ length: 40000 }, (_, index) => `missing-${index}`),
        ],
      },
    };
    expect(await countRecords(db, "acme", "customers", large)).toBe(1);
    await enforcer.addPolicy(
      "rep",
      "/collections/customers",
      "read",
      "true",
      "",
    );
    selects = 0;
    expect(
      (await collectionReadScope(db, enforcer, caller, collection)).where,
    ).toBeUndefined();
    expect(selects).toBe(0);
  } finally {
    await jobsFor(db)?.close();
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Casbin tuple preprocessing preserves strings, nesting, grouping, and array literals in both module builds", async () => {
  const { Util } = await import("casbin");
  const { createRequire } = await import("node:module");
  const cjs = createRequire(import.meta.url)(
    "casbin",
  ) as typeof import("casbin");
  const cases = [
    ["value in ('a', 'b') && enabled", "value in ['a', 'b'] && enabled"],
    [
      "(enabled && (value in ('a', 'b')))",
      "(enabled && (value in ['a', 'b']))",
    ],
    [
      "value in ['a', 'b'] && (enabled || extra)",
      "value in ['a', 'b'] && (enabled || extra)",
    ],
    ["text == ' in (a,b)'", "text == ' in (a,b)'"],
    ['text == " in (a,b)"', 'text == " in (a,b)"'],
    ["value in ('a)\\\'b', 'c')", "value in ['a)\\\'b', 'c']"],
    ["value in (left + (1 * 2), right)", "value in [left + (1 * 2), right]"],
    ["value in (choices)", "value in (choices)"],
    ["data.in('a', 'b')", "data.in('a', 'b')"],
  ];
  for (const [source, expected] of cases) {
    expect(Util.bracketCompatible(source!)).toBe(expected!);
    expect(cjs.Util.bracketCompatible(source!)).toBe(expected!);
  }
  const { CONDITIONAL_MODEL } = await import("../src/db/conditional-policy");
  for (const implementation of [await import("casbin"), cjs]) {
    const model = implementation.newModel();
    model.loadModelFromText(CONDITIONAL_MODEL);
    const enforcer = await implementation.newEnforcer(model);
    await enforcer.addPolicy(
      "rep",
      "/collections/quotes",
      "update",
      condition,
      "limit",
    );
    for (const discount of [10, 11]) {
      const r = context(discount);
      expect(
        await enforcer.enforce("rep", r.obj, "update", r.next, r.usr),
      ).toBe(discount === 10);
      expect(enforcer.enforceSync("rep", r.obj, "update", r.next, r.usr)).toBe(
        discount === 10,
      );
    }
    const missing = context();
    missing.next.refs.customer = null;
    await enforcer.clearPolicy();
    await enforcer.addPolicy(
      "rep",
      "/collections/quotes",
      "update",
      "r.next.refs.customer.limit >= 0",
      "Missing customer",
    );
    expect(
      await enforcer.enforce(
        "rep",
        missing.obj,
        "update",
        missing.next,
        missing.usr,
      ),
    ).toBe(false);
    expect(
      enforcer.enforceSync(
        "rep",
        missing.obj,
        "update",
        missing.next,
        missing.usr,
      ),
    ).toBe(false);
    await enforcer.addPolicy(
      "rep",
      "/collections/quotes",
      "update",
      "true",
      "",
    );
    expect(
      await enforcer.enforce(
        "rep",
        missing.obj,
        "update",
        missing.next,
        missing.usr,
      ),
    ).toBe(true);
    expect(
      enforcer.enforceSync(
        "rep",
        missing.obj,
        "update",
        missing.next,
        missing.usr,
      ),
    ).toBe(true);
  }
});

test("missing related attributes deny only that policy and preserve additive access", async () => {
  const policy = {
    subject: "rep",
    resource: "/collections/quotes",
    action: "update",
    cond: "r.next.refs.customer.limit >= r.next.data.discount",
    msg: "Customer limit exceeded.",
  };
  const next = context();
  next.next.refs.customer = null;
  const enforcer = await conditionalEnforcer([policy], []);
  expect(await allowedRuleRows(enforcer, "rep", "update", [next])).toEqual([
    false,
  ]);
  await expect(
    enforceRuleWrite(enforcer, "rep", "update", next),
  ).rejects.toThrow(policy.msg);
  await enforcer.addPolicy("rep", "/collections/quotes", "update", "true", "");
  await expect(
    enforceRuleWrite(enforcer, "rep", "update", next),
  ).resolves.toBeUndefined();
  expect(compileRule(policy.cond).evaluate(next)).toBe(false);
});
