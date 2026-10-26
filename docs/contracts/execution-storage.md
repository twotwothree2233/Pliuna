# 执行、事务与恢复

状态：行为及默认值已确认；状态编码和[初始 SQL](sql/001-core.sql)为实现草案。运行时尚未实现。

## 生命周期编码

| 对象 | 状态 | 进入终态的条件 |
| --- | --- | --- |
| Task | active / stopping / stopped / deleting | stopped 要求必要任务执行清理完成；deleting 不可恢复业务 |
| 待启动请求 | queued / confirmation_required / started / cancelled / rejected | started 后关联 Run，不提前建占位 Run |
| Run | running / waiting / completed / failed / cancelled / interrupted | 固定拟终态及首要原因，必要清理完成后才终态 |
| Call | registered / waiting / executing / finalizing / ended | 接收/保存或异常清理完成；执行事实另存 |
| Action | registered / waiting / executing / ended | 结果已确定且必要清理完成；等待/清理原因另存 |
| Approval | decision=pending/approve/deny；validity=valid/expired/revoked；handling=evaluating/awaiting_human/resolved | 三个维度独立；撤权不抹掉批准事实 |

Action result 为 success/not_executed/failure/cancelled/unknown；Call execution 另包含 partial，delivery 为 not_applicable/pending/delivered/failed。终态只追加可验证的后续事实，不修改既有结论。Action 正在进行必要清理时使用 waiting + ending_cleanup，不能重新获得业务执行资格。

## 状态转换与占用

| 事件 | 持久化及执行 | 占用规则 |
| --- | --- | --- |
| 请求开始 | 同事务检查任务 active、无未结束 Run、配置有效，创建 Run 并标请求 started | Run/config 占用建立；模型并发名额仅实际请求时持有 |
| 等审批/名额 | Run waiting，原因明确；Call/Action 各自等待 | 不持任务写事务；既有 Run/config/父实例占用不释放 |
| 批准 | 保存原 Approval 的决定，执行前重新核验期限、源资格、版本 | 不预留目标插件名额；嵌套目标忙碌则未执行 |
| 派发 | Call executing；确认完整写通道后 dispatch=sent，调用授权 Action 成功 | 不证明插件已执行；Call 占实例直到 ended |
| 业务提交 | 同事务业务值、记录、引用、Action success | 事务外发送响应；发送失败不改提交事实 |
| 工具返回 | Call finalizing，接收/校验/保存；完成后 ended | 结果可读即 delivered，不等待消费方确认 |
| Run 任意结束 | 先 commit_valid=false，固定 intended_terminal/primary_reason，清理时 waiting | 清理完成才释放该 Run 占用；不释放其他执行的占用 |
| Task stop | 在任务写入顺序中先置 stopping，撤销旧提交资格，取消所有所属执行 | 独立动作也取消；基础用户输入仍允许 |
| 重启 | 新 runtime_epoch，废止旧许可，核对旧执行及必要清理 | 不恢复旧 Run/调用/审批；异常 Run 保留既定原因或 interrupted |

registered 可直接 executing；验证拒绝可直接结束为 not_executed。waiting 可进入 executing 或因拒绝/过期/取消结束；结束清理原因的 waiting 不允许再进入业务 executing。Call 返回后即使取消响应已到，也必须完成必要收尾才 ended。

发送失败能确定未发送则 not_sent/not_executed，不能确定则 dispatch=unknown；完整发送后丢结果为 sent/execution unknown。未知情况不自动重发。Run 首要原因按宿主确立结束边界的顺序固定，而不是跨进程时间戳。

## 短事务与并发

runtime 是业务数据库唯一写入者；内部持久化模块提供受控事务，不把裸连接交给 renderer、主进程或任意插件。模型请求、插件调用、审批等待、文件 I/O 和 bundle 预检不在写事务中。

| 事务 | 必须原子完成 |
| --- | --- |
| Surface 发布 | 当前 Surface/View/布局与状态版本、已发布历史、证据快照、引用、业务记录、Action 成功 |
| 任务数据修改 | 预期版本和删除引用检查、当前值及版本、引用关系、审计、Action 成功 |
| 正式作答 | 再查内容/草稿版本、格式校验结果、原始及正式答案、事件；提交成功后才入推理处理 |
| 草稿保存 | expected_state_revision、允许字段修改、新 state_revision、自动修改资格撤销 |
| Call 结果 | 结果/资源可读引用、执行/交付事实；生命周期结束仅在必要清理完成后 |
| 停止/取消 | 固定来源失效边界、审批和未派发工作失效、必要清理登记 |

提交事务内重新检查当前权限依据、源有效性、预算、目标状态与版本；不得依据过期的预检查。必要的较重解析可在事务外做，但其输入版本/摘要必须在事务内核对。磁盘满或数据库失败不声称已提交。

## 文件发布、上传与回收

upload.begin 返回宿主 upload_id，绑定真实连接、目标任务、所属 Call/Action、总长度及摘要。upload.chunk 必须 offset 等于当前接收长度，解码后大小受分块限制；乱序/重复拒绝，不做幂等成功响应。upload.finish 核对总量和摘要后转 prepared，尚不是可业务引用资源。

未完成传输随连接失效，不跨连接/重启续传；新上传新 ID。已完成并交给持久 Action 的产物按 Action 生命周期保留，不因原连接退出删除。暂存没有提交授权。

保存前持久化 staging/pin，绑定 owner 和 runtime epoch；有界临时文件校验后发布不可变文件，再在短事务登记资源与正式引用并解除临时保护。发布前后均受 pin 保护；GC 检查 owner、正式引用及保存状态，不仅按时间或“暂时无引用”删除。

旧 epoch 不能直接视为可删：重启先查询业务提交事实，保留已提交产物，对无有效 owner 且无引用的临时项登记回收。可变业务引用和不可变历史/恢复点保护分别维护，不能因任务源对象更新就删除历史资产。

## 清理与维护

必要清理包括撤销提交资格、停止直接管理的执行、关闭连接及执行资源；失败继续收尾，不提供忽略清理继续。首次失败后按 1/5/15 秒有界重试，耗尽显示残留及重试入口。手动重试只重试清理，不重执行业务，不把停止未知改成已停止。

已不可访问、不可提交的孤立/失效暂存文件删除可延后，失败显示维护记录和空间，不占 Run/config/插件执行槽。自动清理不淘汰正式材料、历史、答案或有效恢复点；磁盘不足拒绝新保存，用户明确删除。未发布草稿的过期数值需实现配置，不借用已经撤销的去重窗口。

## 迁移与恢复点

维护模式先一致性备份再向前迁移；只有一个有效恢复点。恢复旧数据必须本人确认时间、范围与较新数据替换风险，不允许辅助审批代答。恢复数据不恢复执行。

恢复点废止记录必须保存在不会被恢复旧业务数据库覆盖的控制清单中，原子发布控制清单后才允许清理备份或删除任务。SQL 的 recovery_points 是查询投影，不作为唯一废止依据；这一平台文件的持久性与崩溃顺序必须实测。任务删除先废止包含它的恢复点，清理可继续，旧备份不能复活任务。

## 必测竞态

- 批准与取消竞争：失效边界之后不得派发；批准历史保留。
- 审批期间输入/对象变化：旧 Action 返回冲突，不修改批准绑定。
- 提交后响应丢失：持久结果仍成功，再提交是新操作。
- 发布文件后 DB 失败：允许孤立产物，GC 不删仍在保存的文件。
- 部分发送后断线：结果未知，不重发或伪报未执行。
- 正常完成进入收尾后清理失败：主业务结论保持，仍非终态。
- Task 停止期间答案保存：答案/事件原子保存但无推理队列，不恢复后自动处理。
- UI 重连、后台重启：仅重新同步，不自动恢复旧业务请求。

SQL 是初始核心结构，不通过触发器伪装完整状态机。运行时必须验证跨任务外键语义、允许转换、引用保护与不可变历史；这些不能由 schema/SQL 装载成功代替。
