import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseMathSegments } from './math-text';

export { parseMathSegments } from './math-text';

function renderedMath(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
    });
  } catch {
    return '';
  }
}

export default function MathText({ value }: Readonly<{ value: string }>) {
  return <>
    {parseMathSegments(value).map((segment, index) => {
      if (segment.kind === 'text') return <span className="math-text-plain" key={`text-${index}`}>{segment.value}</span>;
      const html = renderedMath(segment.value, segment.kind === 'block');
      if (!html) return <code className="math-text-fallback" key={`fallback-${index}`}>{segment.kind === 'block' ? `$$${segment.value}$$` : `$${segment.value}$`}</code>;
      return <span className={`math-text-formula math-text-formula--${segment.kind}`} dangerouslySetInnerHTML={{ __html: html }} key={`math-${index}`} />;
    })}
  </>;
}
