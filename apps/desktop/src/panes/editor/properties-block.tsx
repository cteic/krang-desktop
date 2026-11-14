import type { Property } from './frontmatter';

export interface PropertiesBlockProps {
  properties: Property[];
}

/** A note's frontmatter as rows of keys and values. It starts closed. */
export function PropertiesBlock({ properties }: PropertiesBlockProps) {
  return (
    <details className="editor-properties">
      <summary>
        Properties <span className="editor-properties-count">{properties.length}</span>
      </summary>
      <dl>
        {properties.map((property, index) => (
          <div className="editor-property" key={`${String(index)}-${property.key}`}>
            <dt>{property.key}</dt>
            <dd>
              {property.list
                ? property.values.map((value, item) => (
                    <span className="editor-chip" key={`${String(item)}-${value}`}>
                      {value}
                    </span>
                  ))
                : property.values.join(' ')}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
