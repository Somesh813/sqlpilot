import { SchemaContext } from '@sqlpilot/shared';

/**
 * Renders a compact, token-efficient description of the relevant schema.
 * Only the tables selected by SchemaContextService are included.
 */
export function renderSchemaContext(context: SchemaContext): string {
  const lines: string[] = [];
  lines.push(`Database engine: ${context.databaseType}`);
  lines.push(`Database name: ${context.databaseName}`);
  lines.push('');
  lines.push('Tables:');

  for (const table of context.tables) {
    const cols = table.columns
      .map((c) => {
        const flags: string[] = [];
        if (c.isPrimaryKey) flags.push('PK');
        if (c.isForeignKey && c.references) flags.push(`FK->${c.references.table}.${c.references.column}`);
        if (!c.nullable) flags.push('NOT NULL');
        return `    ${c.name} ${c.dataType}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
      })
      .join('\n');
    lines.push(`  ${table.name}${table.kind === 'view' ? ' (view)' : ''}:`);
    lines.push(cols);
  }

  if (context.relationships.length > 0) {
    lines.push('');
    lines.push('Relationships:');
    for (const rel of context.relationships) {
      lines.push(`  ${rel.fromTable}.${rel.fromColumn} -> ${rel.toTable}.${rel.toColumn}`);
    }
  }

  if (context.omittedTables.length > 0) {
    lines.push('');
    lines.push(
      `Note: ${context.omittedTables.length} other table(s) exist but were omitted from this context: ${context.omittedTables
        .slice(0, 30)
        .join(', ')}.`,
    );
  }

  return lines.join('\n');
}
