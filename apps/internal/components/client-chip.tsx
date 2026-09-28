/*
 * THE CLIENT-SEARCH CHIP'S WORDS (Brian, 2026-09-27, R80): the type, the name ("Business — owner" for a
 * business hit), and for everyone else the primary business or the masked email domain. One component,
 * so New quote, the configurator and Deliver Return read the same.
 */
import { CLIENT_CHIP_TYPE_LABEL, clientChipDetail, clientChipType, clientSearchLabel, type ChipRow } from '../lib/labels';

export function ClientChipBody({ r }: { r: ChipRow }): React.JSX.Element {
  const type = clientChipType(r);
  const detail = clientChipDetail(r);
  return (
    <>
      <span className="chip-type" data-type={type}>{CLIENT_CHIP_TYPE_LABEL[type]}</span>
      {clientSearchLabel(r)}
      {detail ? <span className="muted"> · {detail}</span> : null}
    </>
  );
}
