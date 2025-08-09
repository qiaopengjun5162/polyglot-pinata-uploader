# Pinata NFT 元数据上传工具

一个用于上传 NFT 图片和元数据到 Pinata IPFS 的 TypeScript 工具。

## 功能特性

- ✅ 单个文件上传（图片 + 元数据）
- ✅ 批量文件夹上传（图片文件夹 + 元数据文件夹）
- ✅ 支持自定义元数据文件后缀
- ✅ 自动生成带后缀和不带后缀的元数据文件
- ✅ 本地保存上传结果和备份
- ✅ 进度提示和超时处理

## 安装和配置

### 1. 安装依赖

```bash
pnpm install
```

### 2. 环境配置

创建 `.env` 文件：

```bash
# Pinata 配置
PINATA_JWT=your_pinata_jwt_here
PINATA_GATEWAY=your_pinata_gateway_here

# 元数据配置（可选）
# 可选值: .json, .txt, .md, .xml 等
# 默认值: .json
METADATA_SUFFIX=.json

# 上传配置（可选）
UPLOAD_TIMEOUT=300000    # 上传超时时间（毫秒，默认5分钟）
MAX_RETRIES=3           # 最大重试次数（默认3次）
RETRY_DELAY=5000        # 重试延迟（毫秒，默认5秒）
```

## 使用方法

### 基本命令

```bash
# 批量上传（默认生成带.json后缀和不带后缀的元数据）
pnpm batch

# 只生成不带后缀的元数据文件
pnpm batch:no-suffix

# 单个文件上传
pnpm single

# 测试连接
pnpm test
```

### 配置元数据后缀

通过环境变量 `METADATA_SUFFIX` 配置：

```bash
# 使用 .txt 后缀
export METADATA_SUFFIX=.txt
pnpm batch

# 使用 .md 后缀
export METADATA_SUFFIX=.md
pnpm batch
```

## 文件结构

```
assets/
├── batch_images/     # 批量图片文件夹
│   ├── 1.png
│   ├── 2.png
│   └── 3.png
└── image/           # 单个图片文件夹
    └── single.png

output/
└── batch-upload-2025-07-30T03-50-33-025Z/
    ├── README.md                    # 说明文档
    └── results/
        └── upload-result.json       # 详细上传结果
```

## 输出结果

上传完成后会生成：

1. **图片文件夹 CID** - 包含所有 NFT 图片
2. **元数据文件夹 CID** - 包含所有元数据 JSON 文件
3. **本地备份** - 上传结果和元数据文件备份
4. **Base URI** - 用于智能合约的 IPFS 链接

## 智能合约集成

在智能合约中使用生成的 Base URI：

```solidity
// 带后缀版本
string public baseURI = "ipfs://YOUR_METADATA_CID_WITH_SUFFIX/folder_from_sdk/";

// 不带后缀版本
string public baseURI = "ipfs://YOUR_METADATA_CID_WITHOUT_SUFFIX/folder_from_sdk/";
```

### 关于 folder_from_sdk

Pinata SDK 的 `fileArray` 方法会自动创建一个名为 `folder_from_sdk` 的文件夹。这是正常行为，不影响功能：

- ✅ **文件访问正常**：所有文件都可以通过 `ipfs://CID/folder_from_sdk/filename` 访问
- ✅ **NFT 合约兼容**：Base URI 中包含 `folder_from_sdk` 路径即可正常工作
- ✅ **元数据链接正确**：图片链接在元数据中正确指向对应文件
