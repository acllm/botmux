/**
 * Bot settings row: collaboration-group bootstrap for DM-born session groups
 * (issue #3588).
 *
 * The editor is deliberately row-per-member rather than a JSON textarea: the
 * whole feature is "configure once, then never type `/role` again", and the
 * server-side preflight is only useful if the user can SEE which row is
 * blocking. Every issue the daemon reports is rendered next to the row it
 * belongs to.
 *
 * Preflight lives on the server because the facts it needs — which bots this
 * deployment actually has, which daemons answer a heartbeat, which profile
 * entries exist — are only available inside a daemon.
 */
import { useEffect, useMemo, useState } from 'react';
import { useT } from './react-hooks.js';
import { DropdownField } from './field-controls.js';
import { FieldTitle } from './dashboard-components.js';

type StartPolicy = 'staged' | 'all';

interface CollabMemberDraft {
  larkAppId: string;
  stage: string;
  prompt: string;
  dependsOn: string[];
}

interface CollabDraft {
  enabled: boolean;
  profileId: string;
  startPolicy: StartPolicy;
  members: CollabMemberDraft[];
}

interface PreflightIssue {
  code: string;
  larkAppId?: string;
  dependsOn?: string;
  path?: string[];
}

interface CollabResponse {
  ok?: boolean;
  enabled?: boolean;
  config?: Partial<CollabDraft> & { members?: CollabMemberDraft[] };
  preflight?: { ok: boolean; errors: PreflightIssue[]; warnings: PreflightIssue[] };
  error?: string;
  message?: string;
}

const EMPTY: CollabDraft = { enabled: false, profileId: '', startPolicy: 'staged', members: [] };

/** Issue code → the sentence shown next to the row. Unknown codes fall through
 *  verbatim so a new server-side check is never silently invisible. */
function issueText(code: string, tr: ReturnType<typeof useT>): string {
  switch (code) {
    case 'collab_disabled': return tr('botDefaults.collabIssueDisabled');
    case 'profile_missing': return tr('botDefaults.collabIssueProfileMissing');
    case 'unknown_bot': return tr('botDefaults.collabIssueUnknownBot');
    case 'bot_not_mentionable': return tr('botDefaults.collabIssueNotMentionable');
    case 'bot_offline': return tr('botDefaults.collabIssueOffline');
    case 'missing_profile_entry': return tr('botDefaults.collabIssueMissingEntry');
    case 'duplicate_member': return tr('botDefaults.collabIssueDuplicate');
    case 'self_in_members': return tr('botDefaults.collabIssueSelf');
    case 'dependency_cycle': return tr('botDefaults.collabIssueCycle');
    case 'unknown_dependency': return tr('botDefaults.collabIssueUnknownDep');
    default: return code;
  }
}

export function SessionGroupCollabRow(props: { appId: string; bots: Array<{ larkAppId: string; name: string }>; profiles: string[] }) {
  const tr = useT();
  const path = `/api/bots/${encodeURIComponent(props.appId)}/session-group-collab-config`;
  const [draft, setDraft] = useState<CollabDraft>(EMPTY);
  const [preflight, setPreflight] = useState<CollabResponse['preflight']>(undefined);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    void fetch(path, { signal: controller.signal }).then(async response => {
      const body = await response.json() as CollabResponse;
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      setDraft({
        enabled: body.enabled === true,
        profileId: body.config?.profileId ?? '',
        startPolicy: (body.config?.startPolicy === 'all' ? 'all' : 'staged'),
        members: (body.config?.members ?? []).map(m => ({
          larkAppId: m.larkAppId,
          stage: m.stage ?? '',
          prompt: m.prompt ?? '',
          dependsOn: m.dependsOn ?? [],
        })),
      });
      setPreflight(body.preflight);
      setReady(true);
      setFeedback('');
    }).catch((error: unknown) => { if (!controller.signal.aborted) setFeedback(String(error)); });
    return () => controller.abort();
  }, [path, reload]);

  const candidates = useMemo(
    () => props.bots.filter(b => b.larkAppId !== props.appId),
    [props.bots, props.appId],
  );

  /** Errors grouped by the member row they belong to. */
  const errorsByMember = useMemo(() => {
    const map = new Map<string, PreflightIssue[]>();
    for (const issue of preflight?.errors ?? []) {
      if (!issue.larkAppId) continue;
      map.set(issue.larkAppId, [...(map.get(issue.larkAppId) ?? []), issue]);
    }
    return map;
  }, [preflight]);

  const globalIssues = (preflight?.errors ?? []).filter(i => !i.larkAppId);

  function patch(next: Partial<CollabDraft>): void {
    setDraft(current => ({ ...current, ...next }));
  }

  function patchMember(index: number, next: Partial<CollabMemberDraft>): void {
    setDraft(current => ({
      ...current,
      members: current.members.map((m, i) => (i === index ? { ...m, ...next } : m)),
    }));
  }

  function addMember(): void {
    const used = new Set(draft.members.map(m => m.larkAppId));
    const free = candidates.find(b => !used.has(b.larkAppId));
    if (!free) return;
    patch({ members: [...draft.members, { larkAppId: free.larkAppId, stage: '', prompt: '', dependsOn: [] }] });
  }

  function removeMember(index: number): void {
    const removed = draft.members[index]?.larkAppId;
    setDraft(current => ({
      ...current,
      members: current.members
        .filter((_, i) => i !== index)
        // Drop dangling dependency edges so a removal never leaves a config the
        // server would reject with "depends on X, which is not a member".
        .map(m => ({ ...m, dependsOn: m.dependsOn.filter(d => d !== removed) })),
    }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setFeedback('');
    try {
      const payload = {
        collab: {
          enabled: draft.enabled,
          ...(draft.profileId.trim() ? { profileId: draft.profileId.trim() } : {}),
          startPolicy: draft.startPolicy,
          members: draft.members.map(m => ({
            larkAppId: m.larkAppId,
            ...(m.stage.trim() ? { stage: m.stage.trim() } : {}),
            ...(m.prompt.trim() ? { prompt: m.prompt } : {}),
            ...(m.dependsOn.length ? { dependsOn: m.dependsOn } : {}),
          })),
        },
      };
      const response = await fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as CollabResponse;
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      setPreflight(body.preflight);
      setFeedback(tr('roles.saved'));
    } catch (error: unknown) {
      setFeedback(String(error));
    } finally {
      setBusy(false);
    }
  }

  const memberLabel = (appId: string): string =>
    props.bots.find(b => b.larkAppId === appId)?.name ?? appId.slice(0, 12);

  return (
    <div className="bd-row bd-sg-collab" data-session-group-collab-row>
      <div className="bd-field">
        <FieldTitle help={tr('botDefaults.collabHelp')}>{tr('botDefaults.collab')}</FieldTitle>
        <label className="filter-toggle">
          <input
            type="checkbox"
            data-input="sessionGroupCollabEnabled"
            checked={draft.enabled}
            disabled={!ready || busy}
            onChange={event => patch({ enabled: event.currentTarget.checked })}
          />
          <span className="filter-toggle-switch" aria-hidden="true"></span>
          <span className="filter-toggle-label">{tr('botDefaults.collabEnabled')}</span>
        </label>
        <p className="bd-help">{tr('botDefaults.collabEnabledHelp')}</p>

        {draft.enabled ? (
          <>
            {/* A custom dropdown must NOT be nested inside a label element:
                clicking anywhere in that label would activate the first
                option. Each field is a div with its own aria-label on the
                control. */}
            <div className="bd-sg-collab-grid">
              <div className="bd-field">
                <span>{tr('botDefaults.collabProfile')}</span>
                <DropdownField
                  dataInput="sessionGroupCollabProfile"
                  ariaLabel={tr('botDefaults.collabProfile')}
                  value={draft.profileId}
                  disabled={!ready || busy}
                  options={[
                    { value: '', label: tr('botDefaults.collabProfileNone') },
                    ...props.profiles.map(id => ({ value: id, label: id })),
                  ]}
                  onChange={profileId => patch({ profileId })}
                />
                <small>{tr('botDefaults.collabProfileHelp')}</small>
              </div>
              <div className="bd-field">
                <span>{tr('botDefaults.collabStartPolicy')}</span>
                <DropdownField
                  dataInput="sessionGroupCollabStartPolicy"
                  ariaLabel={tr('botDefaults.collabStartPolicy')}
                  value={draft.startPolicy}
                  disabled={!ready || busy}
                  options={[
                    { value: 'staged', label: tr('botDefaults.collabStartStaged') },
                    { value: 'all', label: tr('botDefaults.collabStartAll') },
                  ]}
                  onChange={value => patch({ startPolicy: value === 'all' ? 'all' : 'staged' })}
                />
                <small>{tr('botDefaults.collabStartPolicyHelp')}</small>
              </div>
            </div>

            <div className="bd-sg-collab-members" data-sg-collab-members>
              {draft.members.length === 0 ? (
                <p className="bd-help">{tr('botDefaults.collabNoMembers')}</p>
              ) : null}
              {draft.members.map((member, index) => {
                const issues = errorsByMember.get(member.larkAppId) ?? [];
                return (
                  <div className="bd-sg-collab-member" key={`${member.larkAppId}-${index}`} data-sg-collab-member>
                    <div className="bd-sg-collab-member-head">
                      <DropdownField
                        dataInput={`sessionGroupCollabMemberBot-${index}`}
                        ariaLabel={tr('botDefaults.collabMemberBot')}
                        value={member.larkAppId}
                        disabled={!ready || busy}
                        options={candidates.map(b => ({ value: b.larkAppId, label: b.name }))}
                        onChange={larkAppId => patchMember(index, { larkAppId })}
                      />
                      <input
                        type="text"
                        data-input={`sessionGroupCollabMemberStage-${index}`}
                        aria-label={tr('botDefaults.collabMemberStage')}
                        placeholder={tr('botDefaults.collabMemberStagePlaceholder')}
                        value={member.stage}
                        disabled={!ready || busy}
                        onChange={event => patchMember(index, { stage: event.currentTarget.value })}
                      />
                      <button type="button" className="danger" disabled={!ready || busy} onClick={() => removeMember(index)}>
                        {tr('botDefaults.collabRemoveMember')}
                      </button>
                    </div>
                    <textarea
                      data-input={`sessionGroupCollabMemberPrompt-${index}`}
                      aria-label={tr('botDefaults.collabMemberPrompt')}
                      placeholder={tr('botDefaults.collabMemberPromptPlaceholder')}
                      value={member.prompt}
                      disabled={!ready || busy}
                      rows={2}
                      onChange={event => patchMember(index, { prompt: event.currentTarget.value })}
                    />
                    <div className="bd-sg-collab-deps">
                      <span>{tr('botDefaults.collabMemberDependsOn')}</span>
                      {draft.members.filter((_, i) => i !== index).map(other => (
                        <label key={other.larkAppId} className="bd-sg-collab-dep">
                          <input
                            type="checkbox"
                            checked={member.dependsOn.includes(other.larkAppId)}
                            disabled={!ready || busy}
                            onChange={event => patchMember(index, {
                              dependsOn: event.currentTarget.checked
                                ? [...member.dependsOn, other.larkAppId]
                                : member.dependsOn.filter(d => d !== other.larkAppId),
                            })}
                          />
                          {memberLabel(other.larkAppId)}
                        </label>
                      ))}
                      {draft.members.length <= 1 ? <span className="bd-help">{tr('botDefaults.collabNoDeps')}</span> : null}
                    </div>
                    {issues.length > 0 ? (
                      <p className="status-error" data-sg-collab-member-issue>
                        {issues.map(i => issueText(i.code, tr)).join('；')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <button type="button" disabled={!ready || busy || candidates.length <= draft.members.length} onClick={addMember}>
              {tr('botDefaults.collabAddMember')}
            </button>

            {globalIssues.length > 0 ? (
              <p className="status-error" data-sg-collab-issue>
                {globalIssues.map(i => issueText(i.code, tr)).join('；')}
              </p>
            ) : null}
            {(preflight?.warnings ?? []).length > 0 ? (
              <p className="bd-help" data-sg-collab-warning>
                {preflight!.warnings.map(i => issueText(i.code, tr)).join('；')}
              </p>
            ) : null}
            {preflight?.ok === false && globalIssues.length === 0 && draft.members.length > 0 ? (
              <p className="bd-help" data-sg-collab-blocked>{tr('botDefaults.collabBlocked')}</p>
            ) : null}
          </>
        ) : null}

        <div className="bd-sg-collab-actions">
          <button type="button" className="primary" disabled={!ready || busy} onClick={() => void save()}>
            {tr('roles.save')}
          </button>
          {!ready && feedback ? (
            <button type="button" onClick={() => setReload(current => current + 1)}>{tr('listeners.retry')}</button>
          ) : null}
          <span role="status" data-sg-collab-status>{feedback}</span>
        </div>
      </div>
    </div>
  );
}
