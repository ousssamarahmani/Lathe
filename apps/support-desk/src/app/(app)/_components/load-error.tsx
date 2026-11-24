import ui from '../../_components/ui.module.css';

/** What a page shows when its action was refused. Never shows another org's data. */
export function LoadError({ code }: { code: string }) {
  const text =
    code === 'not_found'
      ? 'Not found.'
      : code === 'forbidden'
        ? 'Your role does not allow this.'
        : 'This could not be loaded.';
  return (
    <div className={ui.card} role="alert">
      <p>{text}</p>
    </div>
  );
}
