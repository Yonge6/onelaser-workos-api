export type Language = 'zh' | 'en';
export function languageFrom(header?:string):Language {
  if(!header) return 'zh';
  const preferences=header.split(',').map((entry,index)=>{
    const [tag,...parts]=entry.trim().toLowerCase().split(';');
    const qPart=parts.find(p=>p.trim().startsWith('q='));
    const q=qPart?Number(qPart.trim().slice(2)):1;
    return {tag:tag.split('-')[0],q:Number.isFinite(q)?q:0,index};
  }).filter(p=>(p.tag==='zh'||p.tag==='en')&&p.q>0&&p.q<=1).sort((a,b)=>b.q-a.q||a.index-b.index);
  return preferences[0]?.tag as Language || 'zh';
}
const zh:Record<string,string>={
  'Only the objective owner can self-evaluate':'只有目标负责人可以提交成果与自评。',
  'A different manager must verify the result':'须由另一位有权限的负责人核定成果。',
  'Self evaluation changed; submit current evidence first':'成果或指标已更新，请负责人先提交当前版本的成果与自评。',
  'Authentication is required':'请先登录后再访问。',
  'Task not found':'未找到可访问的任务。',
  'Invalid request data':'请求数据不符合要求。',
  'Invalid value':'输入值不符合要求。',
  'Request body exceeds limit':'请求内容超过大小限制。',
  'Invalid JSON request':'请求的 JSON 格式无效。',
  'The request could not be completed':'请求暂时无法完成。',
  'Development login is disabled':'开发身份登录已禁用。',
  'Too many development login attempts':'开发登录尝试过于频繁，请稍后再试。',
  'Invalid development credentials':'开发登录凭据无效。',
  'Real DingTalk authentication is not integrated':'真实钉钉身份认证尚未接入。',
  'Employees can create tasks only for themselves':'员工只能为本人创建任务。',
  'Owner must be an active member of the current department':'负责人必须是当前部门的有效成员。',
  'Select a different authorized manager in this department':'请选择同部门的其他授权负责人验收。',
  'The linked key result must be visible to the task owner':'关联的关键结果必须在任务负责人的可见范围内。',
  'Only the task owner can submit evidence':'只有任务负责人可以提交成果。',
  'Task changed; reload before submitting':'任务已更新，请重新读取后再提交。',
  'A designated manager must review evidence':'成果需要由指定的负责人验收。',
  'Task owners cannot review their own work':'任务负责人不能验收本人的工作。',
  'Only the designated reviewer can confirm this task':'只有指定验收人可以确认本任务。',
  'Review must match the currently submitted version':'验收必须对应当前成果版本，请重新读取任务。',
  'A quality score and actual evidence verification are required':'通过验收需要填写质量评分，并确认已实际核对当前成果。',
  'A manager must verify metric updates':'业务指标更新需要由负责人核验。',
  'Key result not found':'未找到可访问的关键结果。',
  'Key result changed; reload before recording':'关键结果已更新，请重新读取后再记录。',
  'AI evidence assessment is not integrated; use human review':'AI 成果评审尚未接入，请使用人工验收。',
  'Notification delivery is not integrated; no message was sent':'通知发送尚未接入，未发送任何消息。',
  'Endpoint not found':'未找到该接口。',
  'Too many requests; try again later':'请求过于频繁，请稍后重试。',
  'Request origin or security token is invalid':'请求来源或安全令牌无效，请刷新后重试。',
  'DingTalk could not complete the request':'钉钉请求未完成，请检查授权或稍后重试。',
  'AI assessment could not be verified; use human review':'AI 评审未能通过验证，请使用人工验收。',
  'Login expired or could not be verified':'登录已过期或无法验证，请重新发起登录。',
  'Department synchronization is unavailable':'当前部门暂时无法同步。',
  'Metric target must differ from baseline in the declared direction':'目标值应按指标方向区别于基准值。',
  'Submit evidence before requesting assessment':'请先提交成果材料再申请评审。',
  'A notification recipient is unavailable':'通知接收者不可用，请先同步部门成员。',
  'Notification is too long; select fewer tasks':'通知内容过长，请减少所选任务。',
  'This notification key was already used for different content':'该通知请求标识已用于其他内容，请重新确认。'
};
export function message(text:string,lang:Language) {return lang==='en'?text:(zh[text]||'请求未能处理，请核对输入或联系管理员。');}
