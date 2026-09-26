/*
 * The 2026-09-26 batch, item F: rulings R45 to R48, one guard broken per ruling.
 *
 *   R45  the confirmation press moves the sign-in. Take the UPDATE portal_users out of
 *        confirmPortalEmailMove and the link is consumed, audited, and moves nothing: the API spec's
 *        "accepting the offer" test reads the old address after the press.
 *   R46  schedules come only from the lines of the accepted quote being engaged; withdrawn engagements
 *        contribute nothing. Take the live-status filter off the quote-lines query in resolveSchedules
 *        and the two withdrawn 1040s put Schedule A back beside B: the master-schedules R46 test is red.
 *   R47  the file input carries no capture attribute and takes several files. Put `capture="environment"`
 *        back in place of `multiple` and the harness reads the camera-only control at both viewports.
 *   R48  the confirmation states what happened. Make the automation-off branch answer "emailed" (the old
 *        claim) and the return-delivered-notice spec's OFF test is red.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log
 * (the harness item needs the harness lock held around the run):
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-f.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

export const items = [
  {
    item: 'R45 the press moves nothing: the UPDATE portal_users in confirmPortalEmailMove removed',
    file: 'apps/api/src/modules/portal-auth/service.ts',
    change: 'the `UPDATE portal_users SET email = $2 WHERE id = $1` after the token is consumed replaced by nothing; the link is spent and audited and the sign-in stays on the old address',
    test: { kind: 'api', spec: 'test/portal-email-move.spec.ts' },
    apply: (t) => {
      const a = "    await app.db.query(`UPDATE portal_users SET email = $2 WHERE id = $1`, [change.portal_user_id, change.new_email]);\n";
      must(t, a);
      return t.replace(a, '');
    },
    expectRed: /accepting the offer/,
  },
  {
    item: 'R46 withdrawn engagements contribute again: the live-status filter removed from the quote-lines query in resolveSchedules',
    file: 'apps/api/src/modules/engagements/packet.ts',
    change: "`WHERE e.contact_id = $1 AND e.status IN ${LIVE}` on the engagement_scope_items query replaced by `WHERE e.contact_id = $1`; a withdrawn 1040's individual_tax line puts Schedule A back into the packet",
    test: { kind: 'api', spec: 'test/master-schedules.spec.ts' },
    apply: (t) => {
      const a = '       JOIN schedule_for_price_line m ON m.service_line = COALESCE(pbi.service_line, qli.service_line)\n      WHERE e.contact_id = $1 AND e.status IN ${LIVE}\n';
      must(t, a);
      return t.replace(a, '       JOIN schedule_for_price_line m ON m.service_line = COALESCE(pbi.service_line, qli.service_line)\n      WHERE e.contact_id = $1\n');
    },
    expectRed: /R46: schedules come from the accepted quote/,
  },
  {
    item: 'R47 the camera-only control put back: capture="environment" in place of multiple on the file input',
    file: 'apps/portal/app/documents/page.tsx',
    change: '`multiple` on the file input replaced by `capture="environment"`: iOS opens the rear camera with no Photo Library and no Files, and one file at a time',
    test: { kind: 'harness', spec: 'tests/portal-upload-control.spec.ts' },
    apply: (t) => {
      const a = '            accept="image/*,application/pdf"\n            multiple\n';
      must(t, a);
      return t.replace(a, '            accept="image/*,application/pdf"\n            capture="environment"\n');
    },
    expectRed: /upload control/,
  },
  {
    item: 'R48 the old claim: the automation-off branch of afterReturnDelivered answers emailed',
    file: 'apps/api/src/modules/documents/service.ts',
    change: "`notice = { emailed: false, reason: 'automation_off' };` replaced by `notice = { emailed: true, reason: 'sent' };` — Deliver Return would again print \"the client was emailed\" with the notice switched off",
    test: { kind: 'api', spec: 'test/return-delivered-notice.spec.ts' },
    apply: (t) => {
      const a = "    notice = { emailed: false, reason: 'automation_off' };\n";
      must(t, a);
      return t.replace(a, "    notice = { emailed: true, reason: 'sent' };\n");
    },
    expectRed: /OFF: the return is on the portal/,
  },
];
