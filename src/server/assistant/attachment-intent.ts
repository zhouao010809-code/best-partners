/** Only the current composer message can enable attachment writes, never file text or old turns. */
export function attachmentIntent(message: string): { archive: boolean; extract: boolean } {
  const command = message.replace(/```[\s\S]*?```/gu, '').replace(/[“「『"][^”」』"]*[”」』"]/gu, '');
  const clauses = command.split(/[，,。！？!?\n]/u).map(value => value.trim()).filter(Boolean);
  const negative = /(?:不要|不用|不必|不想|不需要|不允许|禁止|暂不|别).{0,12}(?:归档|收录|保存|存入|提炼|候选)/u;
  const reported = /(?:文件|附件|原文|文中|材料|资料)(?:里|中|写着|说|要求|提到|建议|提示).*(?:归档|提炼|候选)/u;
  const instructionQuestion = /(?:怎么|如何|怎样).{0,100}(?:归档|提炼|候选)|(?:解释|介绍).{0,30}(?:归档|提炼)|(?:归档|提炼).{0,12}(?:功能|流程|方法|步骤|是什么意思)/u;
  // A request that explicitly rejects source persistence cannot create a persistent extraction either.
  if (clauses.some(value => negative.test(value))) return { archive: false, extract: false };
  const actionable = clauses.filter(value => !reported.test(value) && !instructionQuestion.test(value));
  const prefix = '(?:(?:^|请|帮我|给我|替我|麻烦你|需要你|希望你)(?:先|再|直接|立即|自动|都|也|一起|全部|批量|\\s)*|(?:把|将).{0,100})';
  const extract = actionable.some(value => new RegExp(`${prefix}(?:提炼|整理成(?:知识)?候选)`, 'u').test(value));
  const archive = extract || actionable.some(value => new RegExp(`${prefix}(?:归档|收录|保存到图书馆|存入大脑)(?!流程|方法|步骤|功能)`, 'u').test(value));
  return { archive, extract };
}
