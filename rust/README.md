# NFT Metadata Upload Tool (Rust Version)

一个生产级的NFT元数据上传工具，支持单文件和批量处理，具有灵活的文件后缀配置和双版本生成功能。

## 功能特性

### 🚀 核心功能

- **单文件上传**：支持单个NFT元数据文件上传
- **批量上传**：支持批量NFT元数据文件上传
- **双版本生成**：同时生成带后缀和不带后缀的元数据版本
- **环境变量配置**：支持通过环境变量配置文件后缀
- **进度显示**：实时显示上传进度和时间提示
- **本地保存**：自动保存生成的元数据文件到本地

### 📁 文件后缀支持

- 空字符串 `""`（默认，标准NFT格式）
- `.json`
- `.yaml`
- `.yml`

### 🔧 配置选项

- `METADATA_FILE_SUFFIX`：环境变量，控制元数据文件后缀
- `--both-versions`：命令行参数，生成双版本（带后缀和不带后缀）

## 安装和配置

### 环境要求

- Rust 1.70+
- Pinata API Key

### 安装依赖

```bash
cargo build --release
```

### 环境变量配置

```bash
# 设置Pinata API密钥
export PINATA_API_KEY="your_api_key"
export PINATA_SECRET_KEY="your_secret_key"

# 可选：设置元数据文件后缀
export METADATA_FILE_SUFFIX=".json"  # 或 "" 或 ".yaml" 等
```

## 使用指南

### 1. 单文件上传

```bash
# 上传单个文件
cargo run -- single

# 指定Token ID
cargo run -- single --token-id 1
```

### 2. 批量上传（单版本）

```bash
# 使用默认后缀（无后缀）
cargo run -- batch

# 使用环境变量设置的后缀
METADATA_FILE_SUFFIX=.json cargo run -- batch
```

### 3. 批量上传（双版本）

```bash
# 生成带.json后缀和不带后缀两个版本
cargo run -- batch --both-versions
```

### 4. 测试功能

```bash
# 测试Pinata连接
cargo run -- test

# 检查上传队列状态
cargo run -- queue

# 通过CID固定文件
cargo run -- pin <CID>
```

## 输出结构

### 批量上传输出

```
output/
├── batch-upload-2025-07-31T09-24-29-720Z/
│   ├── results/
│   │   └── upload-result.json
│   └── metadata/
│       ├── 1.json (或 1)
│       ├── 2.json (或 2)
│       └── 3.json (或 3)
```

### 元数据文件格式

```json
{
  "name": "MetaCore #1",
  "description": "A unique member of the MetaCore collection.",
  "image": "ipfs://QmVKhPv53d3WKZi5if4Tm4sZnYEL9t2n7kD4v7ENMqx8WP/1.png",
  "attributes": [
    {
      "trait_type": "ID",
      "value": 1
    }
  ]
}
```

## 开发历程

### 问题解决过程

#### 1. 双版本生成问题

**问题**：双版本生成时，带后缀和不带后缀版本得到相同的CID
**原因**：在同一个文件夹中生成两种版本，第二次覆盖了第一次的文件
**解决**：为两种版本创建不同的文件夹，确保两个不同的CID

#### 2. 环境变量配置问题

**问题**：单版本生成时，环境变量设置的后缀不生效
**原因**：`with_suffix` 参数被硬编码为 `false`
**解决**：根据环境变量动态设置 `with_suffix` 参数

#### 3. 文件同步问题

**问题**：上传到IPFS的文件夹显示为空或文件名不正确
**原因**：文件系统缓存导致文件未及时写入磁盘
**解决**：使用 `file.flush()` 和 `std::process::Command::new("sync")` 强制同步

### 测试验证

#### 双版本生成测试

```bash
METADATA_FILE_SUFFIX=.json cargo run -- batch --both-versions
```

**输出**：

- 带后缀版本：`1.json`, `2.json`, `3.json` → CID: `QmWcz3GW4GTT5czFm4p2GAXPGixnSWXwforotuUgJNbKR3`
- 不带后缀版本：`1`, `2`, `3` → CID: `QmP5wWqhV8zMK9tbLcRvcXDZbtDMVJCY6gGyvvA9hmSk3G`

#### 单版本生成测试

```bash
# 带后缀
METADATA_FILE_SUFFIX=.json cargo run -- batch
# 输出：1.json, 2.json, 3.json

# 不带后缀
cargo run -- batch
# 输出：1, 2, 3
```

## 技术架构

### 核心组件

- **Pinata SDK**：处理IPFS上传
- **Tokio**：异步运行时
- **Serde**：JSON序列化/反序列化
- **Clap**：命令行参数解析
- **Tracing**：日志记录

### 关键函数

- `generate_and_upload_both_versions()`：双版本生成
- `generate_and_upload_single_version()`：单版本生成
- `create_metadata_files()`：元数据文件创建
- `upload_directory_with_retry()`：带重试的上传

### 错误处理

- 指数退避重试机制
- 超时处理
- 文件系统同步
- 详细的错误日志

## 性能优化

### 上传优化

- 并发上传支持
- 文件大小限制检查
- 进度实时显示
- 上传速度计算

### 文件处理优化

- 批量文件读取
- 内存高效的文件操作
- 文件系统同步确保数据完整性

## 最佳实践

### 1. 环境变量管理

```bash
# 推荐使用.env文件
echo "PINATA_API_KEY=your_key" > .env
echo "PINATA_SECRET_KEY=your_secret" >> .env
echo "METADATA_FILE_SUFFIX=.json" >> .env
```

### 2. 批量处理

- 建议批量大小不超过1000个文件
- 监控上传进度和网络状态
- 定期检查IPFS网关状态

### 3. 错误处理

- 网络中断时自动重试
- 文件损坏时重新生成
- 保存详细的错误日志

## 贡献指南

欢迎提交Issue和Pull Request！

### 开发环境设置

```bash
git clone <repository>
cd rust
cargo check
cargo test
```

### 代码规范

- 使用Rust标准格式化
- 添加适当的注释
- 编写单元测试
- 遵循Rust最佳实践

## 许可证

MIT License

## 联系方式

如有问题或建议，请提交Issue或联系开发者。
