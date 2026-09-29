/** @module features/notifications/reports/ReportMessage — a report's `NotificationMessage` drawn natively in the dashboard (D-45, spec 04 §12.11.2): facts as a grid of tiles, the chart as an accessible bar chart (with a visually hidden data table), tables as real tables, lists, paragraphs, code and the muted footer lines; inline runs keep their bold, code, links and times (in the report's zone) */
import type {
  Block,
  Inline,
  InlineRun,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { CHART_INK, chartVar } from '@/components/shared/chart-frame.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { cn } from '@/lib/utils.ts';
import { formatInZone } from '../channels/model.ts';

/** A `chart` block. */
type ChartBlock = Extract<Block, { readonly type: 'chart' }>;

/** Props. */
export interface ReportMessageProps {
  readonly message: NotificationMessage;
  /** The zone its times are written in (the report's). */
  readonly zone: string;
}

/** One inline node. */
function InlineNode({ node, zone }: { readonly node: Inline; readonly zone: string }) {
  switch (node.type) {
    case 'text':
      return <>{node.text}</>;
    case 'bold':
      return <strong className="font-semibold text-foreground">{node.text}</strong>;
    case 'italic':
      return <em>{node.text}</em>;
    case 'code':
      return (
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
          {node.text}
        </code>
      );
    case 'link':
      return (
        <Link to={node.path} className="text-accent-text underline underline-offset-4">
          {node.text}
        </Link>
      );
    case 'time':
      return <time dateTime={new Date(node.at).toISOString()}>{formatInZone(node.at, zone)}</time>;
  }
}

/** An inline run. */
export function Run({ run, zone }: { readonly run: InlineRun; readonly zone: string }) {
  return (
    <>
      {run.map((node, i) => (
        // The run is static content: its position is its identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: an immutable inline run.
        <InlineNode key={i} node={node} zone={zone} />
      ))}
    </>
  );
}

/** The bar chart of a `chart` block: one bar per step, the peak labelled, a hidden table for readers. */
export function ReportChart({
  block,
  zone,
}: {
  readonly block: ChartBlock;
  readonly zone: string;
}) {
  const id = useId();
  const peak = Math.max(...block.values, 0);
  const total = block.values.reduce((a, b) => a + b, 0);
  const width = 640;
  const height = 140;
  const gap = block.values.length > 24 ? 2 : 4;
  const bar = (width - gap * (block.values.length - 1)) / block.values.length;
  const unit = block.unit ?? '';
  const at = (i: number) => block.start + i * block.step_ms;
  const last = block.values.length - 1;
  const ticks = [0, Math.floor(last / 2), last].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure className="flex flex-col gap-2" aria-labelledby={`${id}-caption`}>
      <figcaption
        id={`${id}-caption`}
        className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm"
      >
        <span className="font-medium">{block.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatNumber(total)} in all · peak {formatNumber(peak)}
          {unit === '' ? '' : ` ${unit}`}
        </span>
      </figcaption>
      <svg
        role="img"
        aria-label={`${block.label}: ${formatNumber(total)} in all, peak ${formatNumber(peak)}${unit === '' ? '' : ` ${unit}`}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-36 w-full"
      >
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={CHART_INK.axis} />
        <line x1={0} x2={width} y1={0.5} y2={0.5} stroke={CHART_INK.grid} strokeDasharray="4 4" />
        {block.values.map((value, i) => {
          const h = peak === 0 ? 0 : Math.max(value > 0 ? 2 : 0, (value / peak) * (height - 6));
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional.
              key={i}
              x={i * (bar + gap)}
              y={height - 1 - h}
              width={bar}
              height={h}
              rx={Math.min(3, bar / 3)}
              fill={chartVar('chart-1')}
            />
          );
        })}
      </svg>
      <div aria-hidden="true" className="relative h-4 text-xs text-muted-foreground tabular-nums">
        {ticks.map((i) => (
          <span
            key={i}
            className={cn(
              'absolute top-0 whitespace-nowrap',
              i === 0 ? 'left-0' : i === last ? 'right-0' : '-translate-x-1/2',
            )}
            style={
              i !== 0 && i !== last
                ? { left: `${((i + 0.5) / block.values.length) * 100}%` }
                : undefined
            }
          >
            {formatInZone(at(i), zone)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{block.label}</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">{unit === '' ? 'Value' : unit}</th>
          </tr>
        </thead>
        <tbody>
          {block.values.map((value, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
            <tr key={i}>
              <td>{formatInZone(at(i), zone)}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function BlockView({ block, zone }: { readonly block: Block; readonly zone: string }) {
  switch (block.type) {
    case 'text':
      return (
        <p className="text-base leading-relaxed">
          <Run run={block.content} zone={zone} />
        </p>
      );
    case 'heading':
      return <h3 className="text-base font-semibold">{block.text}</h3>;
    case 'fields':
      return (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {block.items.map((item) => (
            <div
              key={item.label}
              className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-3.5 py-3"
            >
              <dt className="text-sm text-muted-foreground">{item.label}</dt>
              <dd className="text-base font-medium break-words text-foreground tabular-nums">
                <Run run={item.value} zone={zone} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'chart':
      return (
        <div className="rounded-lg border bg-card p-4">
          <ReportChart block={block} zone={zone} />
        </div>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                {block.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="px-3.5 py-2 font-medium whitespace-nowrap"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
                      key={c}
                      className={cn('px-3.5 py-2 align-top', c > 0 && 'tabular-nums')}
                    >
                      <Run run={cell} zone={zone} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List
          className={cn(
            'flex flex-col gap-1.5 pl-5 text-base',
            block.ordered ? 'list-decimal' : 'list-disc',
          )}
        >
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
            <li key={i}>
              <Run run={item} zone={zone} />
            </li>
          ))}
        </List>
      );
    }
    case 'quote':
      return (
        <blockquote className="border-l-2 pl-3 text-base text-muted-foreground">
          <Run run={block.content} zone={zone} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-3 font-mono text-sm">
          {block.text}
        </pre>
      );
    case 'divider':
      return <hr className="border-border" />;
    case 'footer':
      return (
        <p className="text-sm text-muted-foreground">
          <Run run={block.content} zone={zone} />
        </p>
      );
    case 'image':
      return <p className="text-sm text-muted-foreground">{block.alt}</p>;
  }
}

/** The message's blocks, natively. */
export function ReportMessage({ message, zone }: ReportMessageProps) {
  return (
    <div className="flex flex-col gap-5">
      {message.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
        <BlockView key={i} block={block} zone={zone} />
      ))}
    </div>
  );
}
