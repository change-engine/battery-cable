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
  const compositeType = types
    .sort(
      ({ schema }) =>
        -["", "", "pg_catalog", "extensions", ...SCHEAMS].indexOf(schema),
    )
    .find((type) => type.name === pgType && type.attributes.length > 0);
  if (compositeType) {
    if (schemas.some(({ name }) => name === compositeType.schema)) {
      return `Database[${JSON.stringify(compositeType.schema)}]["CompositeTypes"][${JSON.stringify(
        compositeType.name,
      )}]`;
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
      ?.sort(({ name: a }, { name: b }) => a.localeCompare(b))
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

async function generateSchemaFunctions(schemaFunctions) {
  if (schemaFunctions.length === 0) {
    return "      [_ in never]: never";
  }

  const schemaFunctionsGroupedByName = schemaFunctions.reduce((acc, curr) => {
    acc[curr.name] ??= [];
    acc[curr.name].push(curr);
    return acc;
  }, {});

  return (
    await Promise.all(
      Object.entries(schemaFunctionsGroupedByName).map(
        async ([fnName, fns]) =>
          `      ${fnName}: ${(
            await Promise.all(
              fns.map(
                async ({
                  args,
                  return_type_id,
                  return_type_relation_id,
                  is_set_returning_function,
                }) => `{
        Args: ${(() => {
          const inArgs = args.filter(({ mode }) => mode === "in");
          if (inArgs.length === 0) {
            return "Record<PropertyKey, never>;";
          }
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

          return `{
${argsNameAndType
  .map(
    ({ name, type, has_default }) =>
      `          ${name}${has_default ? "?" : ""}: ${type};`,
  )
  .join("\n")}
        };`;
        })()}
        Returns: ${await (async () => {
          const tableArgs = args.filter(({ mode }) => mode === "table");
          if (tableArgs.length > 0) {
            return `{
${tableArgs
  .map(
    ({ name, type_id }) =>
      `          ${name}: ${pgTypeToTsType(
        types.find(({ id }) => id === type_id)?.name,
        types,
      )} | null;`,
  )
  .join("\n")}
        }`;
          }
          const relation = [...tables, ...views].find(
            ({ id }) => id === return_type_relation_id,
          );
          if (relation) {
            return `{
${(
  await Promise.all(
    relation.columns
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(
        async (column) =>
          `          ${column.name}: ${await columnToTsType(column, types)};`,
      ),
  )
).join("\n")}
        }`;
          }
          const type = types.find(({ id }) => id === return_type_id);
          if (type) {
            return pgTypeToTsType(type.name, types);
          }
          return "unknown";
        })()}${is_set_returning_function ? "[];" : ";"}
      }`,
              ),
            )
          ).join("|")};`,
      ),
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
      .filter(({ name }) => SCHEAMS.includes(name))
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(async (schema) => {
        const schemaTables = tables
          .filter((table) => table.schema === schema.name)
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaViews = [...views, ...materializedViews]
          .filter((view) => view.schema === schema.name)
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaFunctions = functions
          .filter(
            (func) =>
              func.schema === schema.name &&
              !["trigger", "event_trigger"].includes(func.return_type),
          )
          .sort(({ name: a }, { name: b }) => a.localeCompare(b));
        const schemaCompositeTypes = types
          .filter(
            (type) => type.schema === schema.name && type.attributes.length > 0,
          )
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
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map(
        async (column) =>
          `          ${column.name}: ${await columnToTsType(column, types)};`,
      ),
  )),
  ...schemaFunctions
    .filter((fn) => fn.argument_types === table.name)
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
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .filter((column) => !column.comment?.startsWith("READONLY:"))
      .map(async (column) =>
        column.is_nullable ||
        column.is_identity ||
        column.default_value !== null
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
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
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
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
      .map((schema) => {
        const schemaCompositeTypes = types
          .filter(
            (type) => type.schema === schema.name && type.attributes.length > 0,
          )
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
