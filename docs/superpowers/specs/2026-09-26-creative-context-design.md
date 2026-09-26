# 项目创作背景与资料选择

用户已于竞品调研后的“可以”批准：项目创作档案、本条资料选择、编辑界面整理。基于 v0.1.4 实施，交付 v0.1.5；拍摄稿、采访卡、选题取舍、发布复盘不在本轮。

## 产品行为

- 项目共用一份可查看、编辑、明确保存的创作档案：受众 audience、目标 goal、表达风格 style、已确认事实 facts、避免表达 avoid。空档案不阻挡创作。可从项目资料生成候选，预览、采用到表单、保存后才生效；不声称自动学会用户风格。
- 用户可指定最多 3 个同项目已定稿的不可变版本作为好稿样本。样本只参考表达，不作为新事实。选择具体版本，之后改稿不会悄悄改变样本。
- 每条稿件持久保存 referenceSelection：默认 auto；selected 明确选择 1–20 个当前项目的可读原始文件。选题策划可使用同样选择，生成的选题继承它。旧稿件默认 auto。
- selected 模式只允许检索/读取所选项目文件，关闭全局知识检索，不把未选择来源的旧证据和历史讨论作为事实带入。当前稿仍作为待编辑文本，旧事实需重新核实；档案中的已确认事实和主动指定的风格样本明确列出。选择不代表已完整阅读；显示本轮实际来源。文件缺失/不可读时阻止调用并给出重新选择的动作，不自动退回全部资料。
- 修改资料范围使已有 AI 建议失效。保存、版本、恢复及另存副本均保留资料范围；旧定稿/导出快照不变。
- 档案是可复用创作偏好，低于本次用户要求和系统边界；文件、稿件、风格样本内文本仍是数据，不得提升为执行或外发权限。
- 编辑时压缩项目标题和资料状态，突出稿件正文；项目问答名称为“讨论项目”，稿件助手为“打磨这篇”。保存版本后不强制展开历史；有定稿时提供直接查看/导出入口。更新相关空态说明。

## 数据与契约

`src/shared/api/creative-profile.ts` 独立定义 CreativeProfileFields、ProjectCreativeProfile（projectId、revision、updatedAt、samples）、CreativeProfileSave、CreativeProfileContext（profile、samples: CreationVersion[]）。初始 revision 为 0，保存使用 expectedRevision 并增至 1。样本引用为 {creationId, versionId}。

`ProjectCreationService` 增加 getProfile(projectId)、saveProfile(projectId,input)、getProfileContext(projectId)。GET/PUT `/api/v1/projects/:projectId/creative-profile`；沿用 CSRF、个人运行时和项目归属边界。客户端 `api.creations.getProfile/saveProfile` 可选能力兼容旧测试/只读连接。

`creationReferenceSelectionSchema` 为 strictObject({mode: enum(auto,selected), paths: array(projectRelativePath).max(20)})；auto 路径为空、selected 路径非空且无重复，不能选择 AI工作区。ProjectCreation/Create/Save/Version 增加 optional referenceSelection，存储默认 auto；版本保存快照。生成请求可为无 item 的策划传 referenceSelection，有 item 时只使用已保存范围。

生成 task 新增 profile，suggestion.profile 为可选 CreativeProfileFields；profile 无 item、不得返回正文替换。生成器构造增加可选 getProfileContext；实际装配必须传入，测试旧适配器可无档案运行。

迁移 023 增加项目档案表与条目/版本资料选择列，不重写任何旧版本正文或原始资料。

## 验收边界

隔离资料验证跨项目归属、档案冲突/重启/样本版本、范围过滤（包含恶意工具调用）、缺失资料、旧稿迁移、晚到建议和选题继承。开发版及完整树构建打包版均验证首次使用和本轮流程，检查宽窄屏。真实账号不做付费调用，不改用户项目资料。沿用未签名 DMG 更新，推送 main、上传校验通过后发布 GitHub Release，并验证线上更新检查。
