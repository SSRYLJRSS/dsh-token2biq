// Official Team mode owns its event, persistence and frontend projection updates.
// This adapter only resolves the exact live session and invokes that public setter.
export function createHostIntegration(getServices, onChanged = () => {}) {
  const modelPolicy = { managedBy: 'official', hint: '模型授权由官方设置管理；更改后新建会话，并用 list_subagent_models 核验可用路由。' };
  function resolve(sessionId) {
    const services = getServices();
    const sid = typeof sessionId === 'string' ? sessionId : '';
    const agents = services.agents?.list?.() || [];
    const agent = sid ? agents.find(a => (a.session?.id || a.session?.sessionId) === sid) : null;
    const team = services.agentTeams;
    const supported = !!(team && typeof team.isEnabled === 'function' && typeof team.setEnabled === 'function' && typeof services.subagents?.rootOf === 'function');
    let enabled = null, root = false, reason = null;
    if (!supported) reason = '宿主未提供官方团队开关接口，请使用官方设置或升级 DSH。';
    else if (!agent) reason = '当前会话尚未激活或已结束，请先打开该会话后重试。';
    else {
      try {
        root = services.subagents.rootOf(agent) === agent;
        enabled = team.isEnabled(agent);
        if (!root) reason = '请在根会话启用官方团队；子代理不能修改团队开关。';
      } catch { reason = '无法核验当前会话的官方团队身份，请重新打开会话。'; }
    }
    return { agent, services, view: { ok: true, sessionId: sid, team: { supported, enabled, canEnable: supported && root && !reason && !enabled, reason }, modelPolicy } };
  }
  function state(sessionId) {
    try { return resolve(sessionId).view; }
    catch { return { ok: false, sessionId, team: { supported: false, enabled: null, canEnable: false, reason: '官方团队服务暂不可用，请稍后重试。' }, modelPolicy }; }
  }
  async function enable(sessionId, enabled) {
    const before = state(sessionId);
    if (enabled !== true) return { ...before, ok: false, persisted: false, code: 'INVALID_REQUEST', error: '此操作仅接受 enabled:true；关闭团队请使用官方开关。' };
    if (!before.ok || before.team.reason) return { ...before, ok: false, persisted: false, code: 'TEAM_UNAVAILABLE', error: before.team.reason };
    try {
      const { agent, services } = resolve(sessionId);
      // Even when enabled already, retry the official setter: it can flush a prior unconfirmed event.
      await services.agentTeams.setEnabled(agent, true);
      onChanged(agent);
      const after = state(sessionId);
      if (after.team.enabled !== true) return { ...after, ok: false, persisted: false, code: 'TEAM_NOT_ENABLED', error: '官方接口返回后团队仍未启用，请使用官方设置核验。' };
      return { ...after, persisted: true };
    } catch {
      // The official setter may append before flush fails; report live state, never fake rollback.
      return { ...state(sessionId), ok: false, persisted: false, code: 'TEAM_ENABLE_UNCONFIRMED', error: '官方团队启用未能确认持久化；请检查当前状态后重试，或使用官方设置。' };
    }
  }
  return { state, enable };
}
