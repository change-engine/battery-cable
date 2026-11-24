#!/usr/bin/env node

import { PostgresMeta } from "@supabase/postgres-meta";
import { compile } from "json-schema-to-typescript";
import fs from "node:fs";
import { format } from "oxfmt";

const SCHEAMS = process.argv[2].split(",");
// Which file to write, src/__definitions__/<name>-definitions.ts, so a project can have the
// types of more than one database (battery's and fueltank's) side by side.
const NAME = process.argv[3] ?? "database";

const pgTypeToTsType = (pgType, types) => {
  if (!pgType) return "unknown";
  if (pgType === "void") return "undefined";
  if (pgType[0] === "_") {
    const element = pgTypeToTsType(pgType.substring(1), types);
    // An enum's or a CHECK list's union needs brackets before [].
    return element.includes("|") ? `(${element})[]` : `${element}[]`;
  }

  const domain = domainByName.get(pgType);
  if (domain) return domain.type ?? pgTypeToTsType(domain.base, types);

  const enumType = types.find((type) => type.name === pgType && type.enums.length > 0);
  if (enumType) {
    return enumType.enums.map((variant) => JSON.stringify(variant)).join(" | ");
  }

  const compositeCandidates = types.filter(
    (type) => type.name === pgType && type.attributes.length > 0,
  );

  if (compositeCandidates.length > 0) {
    const schemaOrder = ["", "", "pg_catalog", "extensions", ...SCHEAMS];
    const getSchemaRank = (schema) => {
      const idx = schemaOrder.indexOf(schema);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    const [compositeType] = compositeCandidates.toSorted((a, b) => {
      const rankDiff = getSchemaRank(a.schema) - getSchemaRank(b.schema);
      if (rankDiff !== 0) return rankDiff;
      const schemaCompare = a.schema.localeCompare(b.schema);
      if (schemaCompare !== 0) return schemaCompare;
      return a.name.localeCompare(b.name);
    });

    if (
      typeof schemas !== "undefined" &&
      schemas.some(({ name }) => name === compositeType.schema)
    ) {
      return `Database[${JSON.stringify(
        compositeType.schema,
      )}]["CompositeTypes"][${JSON.stringify(compositeType.name)}]`;
    }
  }

  return pgType;
};

const replaceLast = (txt, find, replace) => {
  const index = txt.lastIndexOf(find);
  if (index === -1) return txt;
  return txt.substring(0, index) + replace + txt.substring(index + find.length);
};

// Where a JSON schema holds subschemas, so their titles can be dropped too.
const SUBSCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
];

const untitled = (schema) => {
  if (typeof schema !== "object" || schema === null) return schema;
  const result = { ...schema };
  delete result.title;
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    if (keyword in result) {
      result[keyword] = Array.isArray(result[keyword])
        ? result[keyword].map(untitled)
        : untitled(result[keyword]);
    }
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    if (Array.isArray(result[keyword])) result[keyword] = result[keyword].map(untitled);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    if (typeof result[keyword] === "object" && result[keyword] !== null) {
      result[keyword] = Object.fromEntries(
        Object.entries(result[keyword]).map(([key, value]) => [key, untitled(value)]),
      );
    }
  }
  return result;
};

// A schema with each local reference ("#/$defs/<name>" or "#/definitions/<name>") replaced by the
// subschema it names, so that it needs no declarations of its own. Throws for any other reference,
// or one that refers back to itself.
const inlineReferences = (root) => {
  const definitions = { ...root.definitions, ...root.$defs };
  const inline = (schema, seen) => {
    if (Array.isArray(schema)) return schema.map((item) => inline(item, seen));
    if (typeof schema !== "object" || schema === null) return schema;
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/~]+)$/)?.[1];
      if (name === undefined || !Object.hasOwn(definitions, name) || seen.has(name)) {
        throw new Error(`cannot inline ${schema.$ref}`);
      }
      const siblings = { ...schema };
      delete siblings.$ref;
      return inline({ ...definitions[name], ...siblings }, new Set([...seen, name]));
    }
    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [key, inline(value, seen)]),
    );
  };
  const result = inline(root, new Set());
  delete result.$defs;
  delete result.definitions;
  return result;
};

// A JSON schema as one TypeScript type, or undefined. References and titles are inlined so that it
// compiles to a single declaration; a schema that does not parse, holds a reference that cannot be
// inlined, or still compiles to more than one declaration is left to the column's own type.
const jsonSchemaToTsType = async (jsonSchema) => {
  let schema;
  try {
    schema = untitled(inlineReferences(JSON.parse(jsonSchema)));
  } catch {
    return undefined;
  }
  const result = await compile(schema, "Root", {
    bannerComment: "",
    additionalProperties: false,
  });
  if (result.match(/^export /gm)?.length !== 1) return undefined;
  const match = /^export (?:interface Root (\{[\s\S]*\})|type Root =\s*([\s\S]*);)\s*$/.exec(
    result,
  );
  return match?.[1] ?? match?.[2];
};

const getNonNullFields = (comment) => {
  if (!comment) return new Set();
  const match = comment.match(/NON_NULL_FIELDS:\s*([\w,]+)/);
  return match ? new Set(match[1].split(",")) : new Set();
};

const generateViewTypes = async (view, types, relationships, schemaFunctions) => {
  const computedFields = computedFieldsOf(view, schemaFunctions);

  const columns = [
    ...(await Promise.all(
      view.columns
        ?.toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
        .map(async (column) => {
          const baseType = await columnToTsType(column, types);
          // Only add '| null' if the column can be null
          const type = isNonNullColumn(column) ? replaceLast(baseType, " | null", "") : baseType;
          return `          ${column.name}: ${type};`;
        }) ?? [],
    )),
    ...computedFields.map(({ name, type }) => `          ${name}: ${type};`),
  ];

  const relationshipsForView = relationships
    .filter((rel) => view.schema === rel.schema && view.name === rel.relation)

    .toSorted((a, b) =>
      a.foreign_key_name < b.foreign_key_name
        ? -1
        : a.foreign_key_name > b.foreign_key_name
          ? 1
          : 0,
    )
    .map(
      (rel) => `          {
            foreignKeyName: "${rel.foreign_key_name}"
            columns: ${JSON.stringify(rel.columns)}
            isOneToOne: ${rel.is_one_to_one}
            referencedRelation: "${rel.referenced_relation}"
            referencedColumns:  ${JSON.stringify(rel.referenced_columns)}
          },`,
    );

  return `      ${view.name}: {
        Row: {
${columns.join("\n")}
        };
        Relationships: [
${relationshipsForView.join("\n")}
        ];
${computedFieldsMember(computedFields)}
      };`;
};

// A generated column, like an identity column that is always generated, cannot be written.
const columnToTsType = async (c, types, read = true) =>
  !read && (c.identity_generation === "ALWAYS" || c.is_generated)
    ? "never"
    : ((await refinedTypeOf(c, read)) ?? pgTypeToTsType(c.format, types)) +
      (c.is_nullable ? " | null" : "");

// A column's type beyond its Postgres type: its own TYPE: or JSON_SCHEMA: comment; else what a CHECK
// on it allows; else, for a view column that is a plain reference to another relation's column,
// that column's. A NOT VALID check binds writes only, as rows from before it may not meet it.
const refinedTypeOf = async (column, read) => {
  if (column.comment?.startsWith("TYPE: ")) return column.comment.substring(6);
  if (column.comment?.startsWith("JSON_SCHEMA: ")) {
    return jsonSchemaToTsType(column.comment.substring(12));
  }
  const checked = checkedTypes.get(column.id)?.find(({ validated }) => validated || !read);
  if (checked) return checked.type;
  const origin = columnById.get(viewColumnOrigins.get(column.id));
  return origin ? refinedTypeOf(origin, read) : undefined;
};

const ok = async (r) => {
  const { data, error } = await r;
  if (error) throw new Error(error.message);
  return data;
};

const pgMeta = new PostgresMeta({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@0.0.0.0:54322",
});
const [schemas, tables, views, materializedViews, functions, types, allRelationships] =
  await Promise.all([
    ok(pgMeta.schemas.list()),
    ok(pgMeta.tables.list()),
    ok(pgMeta.views.list()),
    ok(pgMeta.materializedViews.list({ includeColumns: true })),
    ok(pgMeta.functions.list()),
    ok(
      pgMeta.types.list({
        includeArrayTypes: true,
        includeSystemSchemas: true,
      }),
    ),
    ok(pgMeta.relationships.list()),
  ]);

// A view is given a copy of every foreign key into each key column it exposes, so one that shows a
// parent's id gets every foreign key to that parent. Keep only the copies that reach the view
// through its own id, which make it a stand-in for the table it takes its id from. PostgREST still
// embeds through the rest, but each deepens the select types postgrest-js builds until TypeScript
// gives up on them.
const viewNames = new Set(
  [...views, ...materializedViews].map(({ schema, name }) => `${schema}.${name}`),
);
const relationships = allRelationships.filter(
  (rel) =>
    !viewNames.has(`${rel.referenced_schema}.${rel.referenced_relation}`) ||
    rel.referenced_columns.includes("id"),
);

// What is read from the catalog beyond postgres-meta's lists, in one query, since each query leaves
// a listener on postgres-meta's pool and Node warns past ten:
// - each function's comment;
// - each table's and view's row type;
// - each domain's base type and checks;
// - every single-column CHECK, in constraint order, and whether it is validated (not NOT VALID);
// - each view's stored query.
const [catalog] = await ok(
  pgMeta.query(`
    SELECT
      (
        SELECT coalesce(json_agg(json_build_object('id', p.oid::int8, 'comment', obj_description(p.oid, 'pg_proc'))), '[]')
        FROM pg_proc p
      ) AS function_comments,
      (
        SELECT coalesce(json_agg(json_build_object('type_id', t.oid::int8, 'relation_id', t.typrelid::int8)), '[]')
        FROM pg_type t
        INNER JOIN pg_class c ON c.oid = t.typrelid
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
      ) AS row_types,
      (
        SELECT coalesce(json_agg(domain), '[]')
        FROM (
          SELECT t.typname AS name, bt.typname AS base,
            coalesce(array_agg(pg_get_constraintdef(c.oid)) FILTER (WHERE c.contype = 'c'), '{}') AS checks
          FROM pg_type t
          INNER JOIN pg_type bt ON bt.oid = t.typbasetype
          LEFT JOIN pg_constraint c ON c.contypid = t.oid
          WHERE t.typtype = 'd'
            AND t.typnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
          GROUP BY t.typname, bt.typname
        ) AS domain
      ) AS domains,
      (
        SELECT coalesce(json_agg(json_build_object(
          'column_id', conrelid::int8 || '.' || conkey[1],
          'definition', pg_get_constraintdef(oid),
          'validated', convalidated
        ) ORDER BY oid), '[]')
        FROM pg_constraint
        WHERE contype = 'c' AND cardinality(conkey) = 1
      ) AS checks,
      (
        SELECT coalesce(json_agg(json_build_object('view_id', r.ev_class::int8, 'action', r.ev_action::text)), '[]')
        FROM pg_rewrite r
        INNER JOIN pg_class c ON c.oid = r.ev_class
        WHERE r.rulename = '_RETURN' AND c.relkind IN ('v', 'm')
      ) AS view_rules
  `),
);
const functionComments = catalog.function_comments;

// Build a map OID → comment
const functionCommentMap = new Map(
  functionComments

    .toSorted((a, b) => {
      if (a.id !== b.id) return a.id - b.id;
      const aComment = a.comment ?? "";
      const bComment = b.comment ?? "";
      return aComment.localeCompare(bComment);
    })
    .map((row) => [row.id, row.comment]),
);

// Attach comment onto each pgMeta.function object
for (const fn of functions) {
  fn.comment = functionCommentMap.get(fn.id) ?? null;
}

// Every table and view by id, with where its type lives in the generated `Database`.
const relationById = new Map([
  ...tables.map(({ id, schema, name }) => [Number(id), { id, schema, name, kind: "Tables" }]),
  ...[...views, ...materializedViews].map(({ id, schema, name }) => [
    Number(id),
    { id, schema, name, kind: "Views" },
  ]),
]);

// Each table's and view's row type, so a function's argument can be matched to its relation.
const relationByRowType = new Map(
  catalog.row_types.map(({ type_id, relation_id }) => [
    Number(type_id),
    relationById.get(Number(relation_id)),
  ]),
);

const rowTypeOf = ({ schema, name, kind }) =>
  `Database[${JSON.stringify(schema)}][${JSON.stringify(kind)}][${JSON.stringify(name)}]["Row"]`;

// The relation a function takes a row of, when that row is its only argument and the relation is
// in the function's schema. PostgREST reads such a function as part of the relation, by the
// function's name: a computed field when it returns a value, or a computed relationship, embedded
// like a foreign key, when it returns rows of another relation.
const rowArgumentOf = (fn) => {
  const inArgs = fn.args.filter(({ mode }) => mode === "in");
  if (inArgs.length !== 1 || inArgs[0].has_default) return undefined;
  const relation = relationByRowType.get(Number(inArgs[0].type_id));
  return relation?.schema === fn.schema ? relation : undefined;
};

// The relation a function returns rows of, when it is in the function's schema. postgrest-js looks
// it up by name in the schema being queried, so one elsewhere gets no `SetofOptions` and is typed
// from `Returns` alone, as before.
const returnRelationOf = (fn) => {
  const relation = relationById.get(Number(fn.return_type_relation_id));
  return relation?.schema === fn.schema ? relation : undefined;
};

// What postgrest-js needs to type `rpc(...).select()` from the returned relation's row, embed
// through that relation's foreign keys, and embed the function itself as a computed relationship
// of the relation named in `from` ("*" when it takes no row and is only called through rpc()).
// SETOF ... ROWS 1 is one-to-one: the embed is an object or null. RETURNS <relation> without SETOF
// embeds a missing row as an object of nulls, which postgrest-js types when `isNotNullable`.
const setofOptionsOf = (fn) => {
  const to = returnRelationOf(fn);
  if (!to) return undefined;
  return {
    from: rowArgumentOf(fn)?.name ?? "*",
    to: to.name,
    isOneToOne: !fn.is_set_returning_function || Number(fn.prorows) === 1,
    isSetofReturn: fn.is_set_returning_function,
    isNotNullable: !fn.is_set_returning_function,
  };
};

// A relation's computed fields: its schema's functions that take its row and return a value rather
// than rows. Each is a key of the relation's `Row`, named in `ComputedFields` so `select("*")`
// leaves it out as PostgREST does.
const computedFieldsOf = (relation, schemaFunctions) =>
  schemaFunctions
    .filter(
      (fn) =>
        rowArgumentOf(fn)?.id === relation.id &&
        relationById.get(Number(fn.return_type_relation_id)) === undefined,
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((fn) => {
      const type = pgTypeToTsType(types.find(({ id }) => id === fn.return_type_id)?.name, types);
      return { name: fn.name, type: `${type}${fn.is_set_returning_function ? "[]" : ""} | null` };
    });

const computedFieldsMember = (computedFields) =>
  computedFields.length === 0
    ? ""
    : `        ComputedFields: ${computedFields.map(({ name }) => JSON.stringify(name)).join(" | ")};`;

// Onto each pgMeta.function object, for its overload below.
for (const fn of functions) {
  fn.rowArgument = rowArgumentOf(fn);
  fn.setofOptions = setofOptionsOf(fn);
}

// An argument as a property name: a computed field's argument may be unnamed.
const propertyName = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

// Every table's and view's column by postgres-meta's id, "<relation oid>.<attnum>".
const columnById = new Map(
  [...tables, ...views, ...materializedViews].flatMap(({ columns }) =>
    (columns ?? []).map((column) => [column.id, column]),
  ),
);
const viewById = new Map([...views, ...materializedViews].map((view) => [Number(view.id), view]));

// Whether the first bracket of a text closes at its end, quoted text skipped.
const enclosesAll = (text) => {
  let depth = 0;
  let quote;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        if (text[i + 1] === quote) i++;
        else quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return true;
};

const unwrap = (text) => {
  let result = text.trim();
  while (result.startsWith("(") && result.endsWith(")") && enclosesAll(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
};

// A CHECK's expression, as pg_get_constraintdef prints it, without CHECK, NOT VALID or brackets.
const checkBody = (definition) =>
  unwrap(definition.replace(/^CHECK /, "").replace(/ NOT VALID$/, ""));

const COLUMN_NAME = String.raw`(?:"((?:[^"]|"")+)"|(\w+))`;
const columnNameOf = (match, at) => match[at]?.replaceAll('""', '"') ?? match[at + 1];

// The literals in an array as pg_get_constraintdef prints it: ARRAY['a'::text, ...], an array literal
// '{a,b}'::text[], or either wrapped and cast to text[] for a varchar column.
const arrayLiterals = (text) => {
  const array = unwrap(text).match(/^\(?ARRAY\[(.*?)\]\)?(?:::[\w ]+\[\])?$/s);
  if (array) {
    const item = /\s*(?:'((?:[^']|'')*)'(?:::[\w ]+)?|(-?\d+(?:\.\d+)?))\s*(?:,|$)/y;
    const literals = [];
    while (item.lastIndex < array[1].length) {
      const match = item.exec(array[1]);
      if (!match) return undefined;
      literals.push(
        match[1] === undefined ? match[2] : JSON.stringify(match[1].replaceAll("''", "'")),
      );
    }
    return literals;
  }
  const literal = unwrap(text).match(/^'\{(.*)\}'::([\w ]+)\[\]$/s);
  if (literal) {
    const numeric = /^(?:smallint|integer|bigint|numeric|real|double precision)$/.test(literal[2]);
    const element = /("(?:[^"\\]|\\.)*"|[^,"]*)(?:,|$)/y;
    const literals = [];
    const elements = literal[1].replaceAll("''", "'");
    while (element.lastIndex < elements.length) {
      const match = element.exec(elements);
      if (!match) return undefined;
      const value = match[1].startsWith('"')
        ? match[1].slice(1, -1).replaceAll(/\\(.)/g, "$1")
        : match[1];
      if (numeric && !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
      literals.push(numeric ? value : JSON.stringify(value));
    }
    return literals;
  }
  return undefined;
};

// A CHECK's expression past a leading "column IS NULL OR", which only restates that the column is
// nullable, as its own type says.
const checkCondition = (definition, name) => {
  const body = checkBody(definition);
  const orNull = body.match(new RegExp(String.raw`^\(?${COLUMN_NAME} IS NULL\)? OR (.*)$`, "s"));
  if (!orNull) return body;
  return columnNameOf(orNull, 1) === name ? unwrap(orNull[3]) : undefined;
};

// The union of literals a CHECK (column = ANY (...)) allows, the way Postgres prints IN (...), or
// undefined for any other check. A domain's check names its value VALUE.
const checkListType = (definition, name) => {
  const match = checkCondition(definition, name)?.match(
    new RegExp(String.raw`^\(*${COLUMN_NAME}\)*(?:::[\w ]+)? = ANY \((.*)\)$`, "s"),
  );
  if (!match || columnNameOf(match, 1) !== name) return undefined;
  const literals = arrayLiterals(match[3]);
  return literals?.length ? literals.join(" | ") : undefined;
};

// The schema a CHECK (jsonb_matches_schema(schema, column)) holds a column to, as the schema's text
// or the name of the function returning it.
const jsonSchemaCheck = (definition, name) => {
  const body = checkCondition(definition, name);
  if (body === undefined) return undefined;
  const match = body.match(
    new RegExp(
      String.raw`^(?:\w+\.)?jsonb_matches_schema\((?:'((?:[^']|'')*)'::jsonb?|((?:\w+\.)?\w+)\(\)), ${COLUMN_NAME}\)$`,
      "s",
    ),
  );
  if (!match || columnNameOf(match, 3) !== name) return undefined;
  return match[1] === undefined
    ? { function: match[2] }
    : { schema: match[1].replaceAll("''", "'") };
};

// Each domain's base type, and the union of literals a CHECK on it allows, if one does.
const domainByName = new Map(
  catalog.domains.map(({ name, base, checks }) => [
    name,
    { base, type: checks.map((check) => checkListType(check, "VALUE")).find(Boolean) },
  ]),
);

// What each column's single-column CHECKs allow, in constraint order: a union of literals, or the
// type of a JSON schema.
const columnChecks = catalog.checks.flatMap(({ column_id, definition, validated }) => {
  const column = columnById.get(column_id);
  if (!column) return [];
  const type = checkListType(definition, column.name);
  const schema = type === undefined ? jsonSchemaCheck(definition, column.name) : undefined;
  return type === undefined && schema === undefined ? [] : [{ column_id, validated, type, schema }];
});

// A schema a check takes from a function is read by calling it, only if it is immutable and so the
// same schema every time. One that fails to call is left out.
// All in one query, for the same reason as the catalog's, so one that fails to call leaves them all
// out. A name is one or two identifiers, as the check's pattern matched it.
const schemaFunctionNames = [
  ...new Set(columnChecks.map(({ schema }) => schema?.function).filter(Boolean)),
];
const schemaByFunction = new Map();
if (schemaFunctionNames.length > 0) {
  const { data } = await pgMeta.query(
    `SELECT ${schemaFunctionNames
      .map(
        (name, i) => `CASE
          WHEN (SELECT provolatile FROM pg_proc WHERE oid = '${name}()'::regprocedure) = 'i'
          THEN ${name}()::text
        END AS schema_${i}`,
      )
      .join(", ")}`,
  );
  for (const [i, name] of schemaFunctionNames.entries()) {
    schemaByFunction.set(name, data?.[0]?.[`schema_${i}`] ?? undefined);
  }
}

const checkedTypes = new Map();
const resolvedChecks = await Promise.all(
  columnChecks.map(async ({ column_id, validated, type, schema }) => {
    const text = schema?.schema ?? schemaByFunction.get(schema?.function);
    return {
      column_id,
      validated,
      type: type ?? (text === undefined ? undefined : await jsonSchemaToTsType(text)),
    };
  }),
);
for (const { column_id, validated, type } of resolvedChecks) {
  if (type !== undefined) {
    checkedTypes.set(column_id, [...(checkedTypes.get(column_id) ?? []), { type, validated }]);
  }
}

// For a view's stored query, "({QUERY ... :targetList ({TARGETENTRY ...} ...) ...})", each output
// column that is a plain reference to another relation's column, as [resno, "<oid>.<attnum>"]:
// Postgres records that relation and column as the entry's resorigtbl and resorigcol. Only the
// outermost query's entries count, each read without anything nested in it (its expression and any
// subquery); a backslash escapes the character after it.
const targetListOrigins = (action) => {
  const origins = [];
  let depth = 0;
  let listDepth;
  let entry;
  for (let i = 0; i < action.length; i++) {
    const char = action[i];
    if (char === "\\") {
      if (entry !== undefined && depth === listDepth + 1) entry += action.slice(i, i + 2);
      i++;
    } else if (char === "{" || char === "(") {
      depth++;
      if (listDepth === undefined && depth === 3 && action.endsWith(":targetList ", i)) {
        listDepth = depth;
      } else if (depth === listDepth + 1) {
        entry = "";
      }
    } else if (char === "}" || char === ")") {
      if (depth === listDepth + 1 && entry !== undefined) {
        const field = (name) => entry.match(new RegExp(`:${name} (\\S+)`))?.[1];
        if (field("resjunk") === "false" && field("resorigtbl") !== "0") {
          origins.push([field("resno"), `${field("resorigtbl")}.${field("resorigcol")}`]);
        }
        entry = undefined;
      }
      if (depth === listDepth) return origins;
      depth--;
    } else if (entry !== undefined && depth === listDepth + 1) {
      entry += char;
    }
  }
  return origins;
};

const viewColumnOrigins = new Map(
  catalog.view_rules.flatMap(({ view_id, action }) =>
    targetListOrigins(action).map(([resno, origin]) => [`${view_id}.${resno}`, origin]),
  ),
);
// Views that can make a column null that is not null where it comes from: an outer join anywhere in
// them, or grouping sets.
const viewsAddingNulls = new Set(
  catalog.view_rules
    .filter(({ action }) => /:jointype [1-9]|:groupingSets \(/.test(action))
    .map(({ view_id }) => Number(view_id)),
);

// Whether a column is never null: NOT NULL on a table; on a view, named in the view's
// NON_NULL_FIELDS, or a plain reference to a column that is never null, through a view that cannot
// add nulls.
const isNonNullColumn = (column) => {
  if (!column.is_nullable) return true;
  const view = viewById.get(Number(column.table_id));
  if (!view) return false;
  if (getNonNullFields(view.comment).has(column.name)) return true;
  const origin = columnById.get(viewColumnOrigins.get(column.id));
  return origin !== undefined && !viewsAddingNulls.has(Number(view.id)) && isNonNullColumn(origin);
};

const parseTypeOverrides = (comment) => {
  const overrides = {};

  if (!comment) return overrides;

  // Find the start of the TYPE_OVERRIDES block
  const startMatch = comment.match(/TYPE_OVERRIDES:\s*{/);
  if (!startMatch) return overrides;

  let i = comment.indexOf(startMatch[0]) + startMatch[0].length;

  // Extract the whole { ... } block with brace counting
  let depth = 1;
  const blockStart = i;
  while (i < comment.length && depth > 0) {
    if (comment[i] === "{") depth++;
    else if (comment[i] === "}") depth--;
    i++;
  }
  const rawBlock = comment.slice(blockStart, i - 1);

  // Now parse entries inside the extracted block
  let p = 0;
  while (p < rawBlock.length) {
    // Skip whitespace
    while (/\s/.test(rawBlock[p])) p++;

    // Parse key name
    const keyMatch = rawBlock.slice(p).match(/^(\w+)\s*:/);
    if (!keyMatch) break;

    const key = keyMatch[1];
    p += keyMatch[0].length;

    // Skip whitespace before the value
    while (/\s/.test(rawBlock[p])) p++;

    // Parse value — may be nested
    const valueStart = p;
    let valueEnd = p;

    if (rawBlock[p] === "{") {
      // Read nested object with brace tracking
      let d = 1;
      valueEnd++; // Move past first '{'
      while (valueEnd < rawBlock.length && d > 0) {
        if (rawBlock[valueEnd] === "{") d++;
        else if (rawBlock[valueEnd] === "}") d--;
        valueEnd++;
      }

      // After exiting braces, capture trailing tokens (e.g. [] | null)
      while (valueEnd < rawBlock.length && !["\n", ","].includes(rawBlock[valueEnd])) {
        valueEnd++;
      }
    } else {
      // Single-line value
      while (valueEnd < rawBlock.length && rawBlock[valueEnd] !== "\n") {
        valueEnd++;
      }
    }

    let typeExpr = rawBlock.slice(valueStart, valueEnd).trim();

    // Clean trailing comma or semicolons
    typeExpr = typeExpr.replace(/[;,]\s*$/, "");

    overrides[key] = typeExpr;

    p = valueEnd;
  }

  return overrides;
};

const argsKey = (fn) =>
  JSON.stringify(
    fn.args.map((arg) => ({
      mode: arg.mode,
      name: arg.name,
      type_id: arg.type_id,
      has_default: arg.has_default,
    })),
  );

const parseFunctionCommentConfig = (comment) => {
  if (!comment) return { nonNull: new Set(), typeOverrides: {} };

  // NON_NULL_FIELDS: [...]
  let nonNull = new Set();
  const nnMatch = comment.match(/NON_NULL_FIELDS:\s*(\[[^\]]*\])/);
  if (nnMatch) {
    try {
      const arr = JSON.parse(nnMatch[1]);
      if (Array.isArray(arr)) nonNull = new Set(arr);
    } catch {
      // Ignore parse errors
    }
  }

  return { nonNull, typeOverrides: parseTypeOverrides(comment) };
};

async function generateSchemaFunctions(schemaFunctions) {
  if (schemaFunctions.length === 0) {
    return "      [_ in never]: never";
  }

  const schemaFunctionsGroupedByName = schemaFunctions.reduce((acc, curr) => {
    acc[curr.name] ??= [];
    acc[curr.name].push(curr);
    return acc;
  }, {});

  const functionNames = Object.keys(schemaFunctionsGroupedByName).toSorted((a, b) =>
    a.localeCompare(b),
  );

  return (
    await Promise.all(
      functionNames.map(async (fnName) => {
        const fns = schemaFunctionsGroupedByName[fnName];

        // All overloads share the same comment
        const commentCfg = parseFunctionCommentConfig(fns[0].comment);
        const { nonNull, typeOverrides } = commentCfg;

        const sortedFns = fns.toSorted((a, b) => {
          if (a.args.length !== b.args.length) {
            return a.args.length - b.args.length;
          }

          const aArgsKey = argsKey(a);
          const bArgsKey = argsKey(b);
          if (aArgsKey !== bArgsKey) {
            return aArgsKey.localeCompare(bArgsKey);
          }

          const aReturnTypeId = a.return_type_id ?? 0;
          const bReturnTypeId = b.return_type_id ?? 0;
          if (aReturnTypeId !== bReturnTypeId) {
            return aReturnTypeId - bReturnTypeId;
          }

          const aReturnRelId = a.return_type_relation_id ?? 0;
          const bReturnRelId = b.return_type_relation_id ?? 0;
          if (aReturnRelId !== bReturnRelId) {
            return aReturnRelId - bReturnRelId;
          }

          if (a.is_set_returning_function !== b.is_set_returning_function) {
            return a.is_set_returning_function ? 1 : -1;
          }

          return 0;
        });

        const overloads = await Promise.all(
          sortedFns.map(
            async ({
              args,
              return_type_id,
              return_type_relation_id,
              is_set_returning_function,
              rowArgument,
              setofOptions,
            }) => {
              //
              // ──────────────────────────────────────────────
              // Args
              // ──────────────────────────────────────────────
              //
              const inArgs = args.filter(({ mode }) => mode === "in");

              let ArgsBlock;
              if (inArgs.length === 0) {
                ArgsBlock = "Record<PropertyKey, never>;";
              } else {
                const argsNameAndType = inArgs.map(({ name, type_id, has_default }) => ({
                  name,
                  // A relation's row is not among `types`; postgrest-js matches a computed field
                  // or relationship by this argument having the same keys as the relation's Row.
                  type: rowArgument
                    ? rowTypeOf(rowArgument)
                    : pgTypeToTsType(types.find(({ id }) => id === type_id)?.name, types),
                  has_default,
                }));

                const sortedArgsNameAndType = argsNameAndType

                  .toSorted((a, b) => a.name.localeCompare(b.name));

                ArgsBlock = `{
${sortedArgsNameAndType
  .map(
    ({ name, type, has_default }) =>
      `          ${propertyName(name)}${has_default ? "?" : ""}: ${type};`,
  )
  .join("\n")}
        };`;
              }

              //
              // ──────────────────────────────────────────────
              // Returns
              // ──────────────────────────────────────────────
              //
              const ReturnsBlock = await (async () => {
                //
                // TABLE-returning functions
                //
                const tableArgs = args.filter(({ mode }) => mode === "table");
                if (tableArgs.length > 0) {
                  const sortedTableArgs = tableArgs

                    .toSorted((a, b) => a.name.localeCompare(b.name));

                  const cols = sortedTableArgs.map(({ name, type_id }) => {
                    if (typeOverrides[name] !== undefined) {
                      const type = typeOverrides[name];
                      return `          ${name}: ${nonNull.has(name) ? type : `${type} | null`};`;
                    }

                    const base = pgTypeToTsType(
                      types.find(({ id }) => id === type_id)?.name,
                      types,
                    );
                    const cleaned = replaceLast(base, " | null", "");
                    const finalType = nonNull.has(name) ? cleaned : `${cleaned} | null`;

                    return `          ${name}: ${finalType};`;
                  });

                  return `{
${cols.join("\n")}
        }`;
                }

                //
                // Relation-returning functions (table or view)
                //
                const relation = [...tables, ...views].find(
                  ({ id }) => id === return_type_relation_id,
                );

                if (relation) {
                  // Nullable where the relation's own column can be null, as rpc(...).select()
                  // types the same rows from the relation's Row. The function's NON_NULL_FIELDS
                  // can only narrow that.
                  const cols = await Promise.all(
                    relation.columns

                      .toSorted((a, b) => a.name.localeCompare(b.name))
                      .map(async (column) => {
                        const name = column.name;
                        const isNonNull = isNonNullColumn(column) || nonNull.has(name);

                        if (typeOverrides[name] !== undefined) {
                          const type = typeOverrides[name];
                          return `          ${name}: ${isNonNull ? type : `${type} | null`};`;
                        }

                        const base = await columnToTsType(column, types);
                        const cleaned = replaceLast(base, " | null", "");
                        const finalType = isNonNull ? cleaned : `${cleaned} | null`;

                        return `          ${name}: ${finalType};`;
                      }),
                  );

                  return `{
${cols.join("\n")}
        }`;
                }

                //
                // Simple type: enum / scalar / composite
                //
                const type = types.find(({ id }) => id === return_type_id);
                if (type) {
                  return pgTypeToTsType(type.name, types);
                }

                return "unknown";
              })();

              //
              // ──────────────────────────────────────────────
              // Wrap final overload
              // ──────────────────────────────────────────────
              //
              // postgrest-js makes a one-to-one set an array itself, so its `Returns` is one row.
              const returnsArray = is_set_returning_function && !setofOptions?.isOneToOne;
              return `{
        Args: ${ArgsBlock}
        Returns: ${ReturnsBlock}${returnsArray ? "[]" : ""};
${
  setofOptions
    ? `        SetofOptions: {
          from: ${JSON.stringify(setofOptions.from)};
          to: ${JSON.stringify(setofOptions.to)};
          isOneToOne: ${setofOptions.isOneToOne};
          isSetofReturn: ${setofOptions.isSetofReturn};
          isNotNullable: ${setofOptions.isNotNullable};
        };`
    : ""
}
      }`;
            },
          ),
        );

        return `      ${fnName}: ${overloads.join("|")};`;
      }),
    )
  ).join("\n");
}

const { code, errors } = await format(
  `${NAME}-definitions.ts`,
  `// Autogenerated by supabase-gen-types ${SCHEAMS.join(",")}

${fs.readFileSync("src/__definitions__/type-definitions.ts", "utf8")}

export interface Database {
${(
  await Promise.all(
    schemas
      .filter(({ name }) => SCHEAMS.includes(name))
      .toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(async (schema) => {
        const schemaTables = tables
          .filter((table) => table.schema === schema.name)

          .toSorted(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaViews = [...views, ...materializedViews]
          .filter((view) => view.schema === schema.name)

          .toSorted(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaFunctions = functions
          .filter(
            (func) =>
              func.schema === schema.name &&
              !["trigger", "event_trigger"].includes(func.return_type),
          )

          .toSorted(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaCompositeTypes = types
          .filter((type) => type.schema === schema.name && type.attributes.length > 0)

          .toSorted(({ name: a }, { name: b }) => a.localeCompare(b));
        return `  ${schema.name}: {
    Tables: {
${
  schemaTables.length === 0
    ? "      [_ in never]: never;"
    : (
        await Promise.all(
          schemaTables.map(
            async (table) => `      ${table.name}: {
        Row: {
${[
  ...(await Promise.all(
    table.columns

      .toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(async (column) => `          ${column.name}: ${await columnToTsType(column, types)};`),
  )),
  ...computedFieldsOf(table, schemaFunctions).map(
    ({ name, type }) => `          ${name}: ${type};`,
  ),
].join("\n")}
        };
        Insert: {
${(
  await Promise.all(
    table.columns

      .toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
      .filter((column) => !column.comment?.startsWith("READONLY:"))
      .map(async (column) =>
        column.is_nullable || column.is_identity || column.default_value !== null
          ? `          ${column.name}?: ${await columnToTsType(column, types, false)};`
          : `          ${column.name}: ${await columnToTsType(column, types, false)};`,
      ),
  )
).join("\n")}
        };
        Update: {
${(
  await Promise.all(
    table.columns

      .toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
      .filter((column) => !column.comment?.startsWith("READONLY:"))
      .map(
        async (column) =>
          `          ${column.name}?: ${await columnToTsType(column, types, false)};`,
      ),
  )
).join("\n")}
        };
        Relationships: [
${relationships
  .filter((rel) => table.schema === rel.schema && table.name === rel.relation)

  .toSorted((a, b) =>
    a.foreign_key_name < b.foreign_key_name ? -1 : a.foreign_key_name > b.foreign_key_name ? 1 : 0,
  )
  .map(
    (rel) => `          {
            foreignKeyName: "${rel.foreign_key_name}"
            columns: ${JSON.stringify(rel.columns)}
            isOneToOne: ${rel.is_one_to_one}
            referencedRelation: "${rel.referenced_relation}"
            referencedColumns:  ${JSON.stringify(rel.referenced_columns)}
          },`,
  )
  .join("\n")}
        ];
${computedFieldsMember(computedFieldsOf(table, schemaFunctions))}
      };`,
          ),
        )
      ).join("\n")
}
    };
    Views: {
${
  schemaViews.length === 0
    ? "      [_ in never]: never;"
    : (
        await Promise.all(
          schemaViews.map((view) => generateViewTypes(view, types, relationships, schemaFunctions)),
        )
      ).join("\n")
}
    };
    Functions: {
${await generateSchemaFunctions(schemaFunctions)}
    };
    CompositeTypes: {
${
  schemaCompositeTypes.length === 0
    ? "      [_ in never]: never;"
    : schemaCompositeTypes
        .map(
          ({ name, attributes }) =>
            `      ${name}: {
${attributes

  .toSorted((a, b) => a.name.localeCompare(b.name))
  .map(({ name: aName, type_id }) => {
    const type = types.find(({ id }) => id === type_id);
    if (type) {
      return `        ${aName}: ${pgTypeToTsType(type.name, types)} | null;`;
    }
    return `        ${aName}: unknown`;
  })
  .join("\n")}
      };`,
        )
        .join("\n")
}
    };
  };`;
      }),
  )
).join("\n")}
${(
  await Promise.all(
    schemas
      .filter(({ name }) => !SCHEAMS.includes(name))
      .toSorted(({ name: a }, { name: b }) => a.localeCompare(b))
      .map((schema) => {
        const schemaCompositeTypes = types
          .filter((type) => type.schema === schema.name && type.attributes.length > 0)

          .toSorted(({ name: a }, { name: b }) => a.localeCompare(b));
        return `  ${schema.name}: {
    Tables: {}
    Views: {}
    Functions: {}
    CompositeTypes: {
${
  schemaCompositeTypes.length === 0
    ? "      [_ in never]: never;"
    : schemaCompositeTypes
        .map(
          ({ name, attributes }) =>
            `      ${name}: {
${attributes

  .toSorted((a, b) => a.name.localeCompare(b.name))
  .map(({ name: aName, type_id }) => {
    const type = types.find(({ id }) => id === type_id);
    if (type) {
      return `        ${aName}: ${pgTypeToTsType(type.name, types)} | null;`;
    }
    return `        ${aName}: unknown`;
  })
  .join("\n")}
      };`,
        )
        .join("\n")
}
    };
  };`;
      }),
  )
).join("\n")}
}

export interface DatabaseWithOptions {
  db: Database
  options: {
    PostgrestVersion: "13"
  }
}
`,
);

// Unlike prettier, oxfmt returns parse errors instead of throwing, so fail here
// rather than write invalid output.
if (errors.length > 0) throw new Error(errors.map(({ message }) => message).join("\n"));

fs.writeFileSync(`src/__definitions__/${NAME}-definitions.ts`, code);

process.exit();
