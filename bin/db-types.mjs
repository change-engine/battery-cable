#!/usr/bin/env node

import { PostgresMeta } from "@supabase/postgres-meta";
import { compile } from "json-schema-to-typescript";
import fs from "node:fs";
import prettier from "prettier";

const SCHEAMS = process.argv[2].split(",");

const pgTypeToTsType = (pgType, types) => {
  if (!pgType) return "unknown";
  if (pgType === "void") return "undefined";
  if (pgType[0] === "_")
    return `${pgTypeToTsType(pgType.substring(1), types)}[]`;

  const enumType = types.find(
    (type) => type.name === pgType && type.enums.length > 0,
  );
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

    const [compositeType] = [...compositeCandidates].sort((a, b) => {
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

const jsonSchemaToTsType = async (jsonSchema) => {
  const result = await compile(JSON.parse(jsonSchema), "MySchema", {
    bannerComment: "",
    additionalProperties: false,
  });

  const [, data] = result.split("export interface GeneratedSchemaForRoot ");
  return data;
};

const getNonNullFields = (comment) => {
  if (!comment) return new Set();
  const match = comment.match(/NON_NULL_FIELDS:\s*([\w,]+)/);
  return match ? new Set(match[1].split(",")) : new Set();
};

const generateViewTypes = async (view, types, relationships) => {
  const nonNullFields = getNonNullFields(view.comment);

  const columns = await Promise.all(
    view.columns
      ?.slice()
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(async (column) => {
        const baseType = await columnToTsType(column, types);
        // Only add '| null' if the field isn't in nonNullFields
        const type = nonNullFields.has(column.name)
          ? replaceLast(baseType, " | null", "")
          : baseType;
        return `          ${column.name}: ${type};`;
      }) ?? [],
  );

  const relationshipsForView = relationships
    .filter((rel) => view.schema === rel.schema && view.name === rel.relation)
    .slice()
    .sort((a, b) =>
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
      };`;
};

const columnToTsType = async (c, types, read = true) =>
  !read && c.identity_generation === "ALWAYS"
    ? "never"
    : (c.comment?.startsWith("TYPE: ")
        ? c.comment.substring(6)
        : c.comment?.startsWith("JSON_SCHEMA: ")
          ? await jsonSchemaToTsType(c.comment.substring(12))
          : pgTypeToTsType(c.format, types)) + (c.is_nullable ? " | null" : "");

const ok = async (r) => {
  const { data, error } = await r;
  if (error) throw new Error(error.message);
  return data;
};

const pgMeta = new PostgresMeta({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@0.0.0.0:54322",
});
const [
  schemas,
  tables,
  views,
  materializedViews,
  functions,
  types,
  relationships,
] = await Promise.all([
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

const functionComments = await ok(
  pgMeta.query(`
    SELECT
      p.oid AS id,
      obj_description(p.oid, 'pg_proc') AS comment
    FROM pg_proc p
  `),
);

// Build a map OID → comment
const functionCommentMap = new Map(
  functionComments
    .slice()
    .sort((a, b) => {
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

async function generateSchemaFunctions(schemaFunctions) {
  if (schemaFunctions.length === 0) {
    return "      [_ in never]: never";
  }

  const parseTypeOverrides = (comment) => {
    const overrides = {};

    if (!comment) return overrides;

    // Find the start of the TYPE_OVERRIDES block
    const startMatch = comment.match(/TYPE_OVERRIDES:\s*{/);
    if (!startMatch) return overrides;

    let i = comment.indexOf(startMatch[0]) + startMatch[0].length;

    // Extract the whole { ... } block with brace counting
    let depth = 1;
    let blockStart = i;
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
      let valueStart = p;
      let valueEnd = p;

      if (rawBlock[p] === "{") {
        // Read nested object with brace tracking
        let d = 1;
        valueEnd++; // move past first '{'
        while (valueEnd < rawBlock.length && d > 0) {
          if (rawBlock[valueEnd] === "{") d++;
          else if (rawBlock[valueEnd] === "}") d--;
          valueEnd++;
        }

        // After exiting braces, capture trailing tokens (e.g. [] | null)
        while (
          valueEnd < rawBlock.length &&
          !["\n", ","].includes(rawBlock[valueEnd])
        ) {
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
        // ignore parse errors
      }
    }

    return { nonNull, typeOverrides: parseTypeOverrides(comment) };
  };

  const schemaFunctionsGroupedByName = schemaFunctions.reduce((acc, curr) => {
    acc[curr.name] ??= [];
    acc[curr.name].push(curr);
    return acc;
  }, {});

  const functionNames = Object.keys(schemaFunctionsGroupedByName).sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    await Promise.all(
      functionNames.map(async (fnName) => {
        const fns = schemaFunctionsGroupedByName[fnName];

        // All overloads share the same comment
        const commentCfg = parseFunctionCommentConfig(fns[0].comment);
        const { nonNull, typeOverrides } = commentCfg;

        const sortedFns = [...fns].sort((a, b) => {
          if (a.args.length !== b.args.length) {
            return a.args.length - b.args.length;
          }

          const argsKey = (fn) =>
            JSON.stringify(
              fn.args.map((arg) => ({
                mode: arg.mode,
                name: arg.name,
                type_id: arg.type_id,
                has_default: arg.has_default,
              })),
            );

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
                const argsNameAndType = inArgs.map(
                  ({ name, type_id, has_default }) => {
                    return {
                      name,
                      type: pgTypeToTsType(
                        types.find(({ id }) => id === type_id)?.name,
                        types,
                      ),
                      has_default,
                    };
                  },
                );

                const sortedArgsNameAndType = argsNameAndType
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name));

                ArgsBlock = `{
${sortedArgsNameAndType
  .map(
    ({ name, type, has_default }) =>
      `          ${name}${has_default ? "?" : ""}: ${type};`,
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
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name));

                  const cols = sortedTableArgs.map(({ name, type_id }) => {
                    if (typeOverrides[name] !== undefined) {
                      const type = typeOverrides[name];
                      return `          ${name}: ${
                        nonNull.has(name) ? type : `${type} | null`
                      };`;
                    }

                    const base = pgTypeToTsType(
                      types.find(({ id }) => id === type_id)?.name,
                      types,
                    );
                    const cleaned = replaceLast(base, " | null", "");
                    const finalType = nonNull.has(name)
                      ? cleaned
                      : `${cleaned} | null`;

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
                  const cols = await Promise.all(
                    relation.columns
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(async (column) => {
                        const name = column.name;

                        if (typeOverrides[name] !== undefined) {
                          const type = typeOverrides[name];
                          return `          ${name}: ${
                            nonNull.has(name) ? type : `${type} | null`
                          };`;
                        }

                        const base = await columnToTsType(column, types);
                        const cleaned = replaceLast(base, " | null", "");
                        const finalType = nonNull.has(name)
                          ? cleaned
                          : `${cleaned} | null`;

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
              return `{
        Args: ${ArgsBlock}
        Returns: ${ReturnsBlock}${is_set_returning_function ? "[]" : ""};
      }`;
            },
          ),
        );

        return `      ${fnName}: ${overloads.join("|")};`;
      }),
    )
  ).join("\n");
}

fs.writeFileSync(
  "src/__definitions__/database-definitions.ts",
  await prettier.format(
    `// Autogenerated by supabase-gen-types ${SCHEAMS.join(",")}

${fs.readFileSync("src/__definitions__/type-definitions.ts", "utf-8")}

export interface Database {
${(
  await Promise.all(
    schemas
      .slice()
      .filter(({ name }) => SCHEAMS.includes(name))
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(async (schema) => {
        const schemaTables = tables
          .filter((table) => table.schema === schema.name)
          .slice()
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaViews = [...views, ...materializedViews]
          .filter((view) => view.schema === schema.name)
          .slice()
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaFunctions = functions
          .filter(
            (func) =>
              func.schema === schema.name &&
              !["trigger", "event_trigger"].includes(func.return_type),
          )
          .slice()
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaCompositeTypes = types
          .filter(
            (type) => type.schema === schema.name && type.attributes.length > 0,
          )
          .slice()
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
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
      .slice()
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(
        async (column) =>
          `          ${column.name}: ${await columnToTsType(column, types)};`,
      ),
  )),
  ...schemaFunctions
    .filter((fn) => fn.argument_types === table.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (fn) =>
        `        ${fn.name}: ${pgTypeToTsType(fn.return_type, types)} | null`,
    ),
].join("\n")}
        };
        Insert: {
${(
  await Promise.all(
    table.columns
      .slice()
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .filter((column) => !column.comment?.startsWith("READONLY:"))
      .map(async (column) =>
        column.is_nullable ||
        column.is_identity ||
        column.default_value !== null
          ? `          ${column.name}?: ${await columnToTsType(
              column,
              types,
              false,
            )};`
          : `          ${column.name}: ${await columnToTsType(
              column,
              types,
              false,
            )};`,
      ),
  )
).join("\n")}
        };
        Update: {
${(
  await Promise.all(
    table.columns
      .slice()
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .filter((column) => !column.comment?.startsWith("READONLY:"))
      .map(
        async (column) =>
          `          ${column.name}?: ${await columnToTsType(
            column,
            types,
            false,
          )};`,
      ),
  )
).join("\n")}
        };
        Relationships: [
${relationships
  .filter((rel) => table.schema === rel.schema && table.name === rel.relation)
  .slice()
  .sort((a, b) =>
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
  )
  .join("\n")}
        ];
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
          schemaViews.map((view) =>
            generateViewTypes(view, types, relationships),
          ),
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
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
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
      .slice()
      .filter(({ name }) => !SCHEAMS.includes(name))
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map((schema) => {
        const schemaCompositeTypes = types
          .filter(
            (type) => type.schema === schema.name && type.attributes.length > 0,
          )
          .slice()
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
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
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
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
    {
      parser: "typescript",
      printWidth: 100,
    },
  ),
);

// eslint-disable-next-line n/no-process-exit
process.exit();
