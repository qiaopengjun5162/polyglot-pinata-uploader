import { PinataSDK } from "pinata";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// --- 类型定义 ---
interface UploadResult {
  cid: string;
  size?: number;
  timestamp: string;
}

interface BatchUploadResult {
  timestamp: string;
  imagesFolderCid: string;
  metadataWithSuffixCid?: string;
  metadataWithoutSuffixCid?: string;
  imageCount: number;
  metadataFiles: Array<{
    tokenId: string;
    metadataFileWithSuffix: string;
    metadataFileWithoutSuffix: string;
  }>;
  totalSize: number;
  uploadTime: number;
}

interface SingleUploadResult {
  timestamp: string;
  imageCid: string;
  metadataCid: string;
  imageUrl: string;
  metadataUrl: string;
  gatewayImageUrl: string;
  gatewayMetadataUrl: string;
  metadata: any;
  uploadTime: number;
}

interface Config {
  pinataJwt: string;
  pinataGateway: string;
  metadataSuffix: string;
  uploadTimeout: number;
  maxRetries: number;
  retryDelay: number;
  maxFileSize: number;
  maxTotalSize: number;
}

// --- 配置管理 ---
class ConfigManager {
  private config: Config;

  constructor() {
    dotenv.config();
    this.config = this.loadConfig();
  }

  private loadConfig(): Config {
    const pinataJwt = process.env.PINATA_JWT;
    const pinataGateway = process.env.PINATA_GATEWAY;

    if (!pinataJwt) {
      throw new Error("❌ 请在 .env 文件中设置 PINATA_JWT");
    }
    if (!pinataGateway) {
      throw new Error("❌ 请在 .env 文件中设置 PINATA_GATEWAY");
    }

    return {
      pinataJwt,
      pinataGateway,
      metadataSuffix: process.env.METADATA_SUFFIX || ".json",
      uploadTimeout: parseInt(process.env.UPLOAD_TIMEOUT || "300000"),
      maxRetries: parseInt(process.env.MAX_RETRIES || "3"),
      retryDelay: parseInt(process.env.RETRY_DELAY || "5000"),
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "52428800"), // 50MB
      maxTotalSize: parseInt(process.env.MAX_TOTAL_SIZE || "524288000"), // 500MB
    };
  }

  getConfig(): Config {
    return this.config;
  }
}

// --- 日志管理 ---
class Logger {
  private static instance: Logger;
  private logLevel: "info" | "warn" | "error" | "debug" = "info";

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLogLevel(level: "info" | "warn" | "error" | "debug") {
    this.logLevel = level;
  }

  private shouldLog(level: "info" | "warn" | "error" | "debug"): boolean {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.logLevel];
  }

  log(message: string, level: "info" | "warn" | "error" | "debug" = "info") {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    switch (level) {
      case "error":
        console.error(logMessage);
        break;
      case "warn":
        console.warn(logMessage);
        break;
      case "debug":
        console.debug(logMessage);
        break;
      default:
        console.log(logMessage);
    }
  }

  info(message: string) {
    this.log(message, "info");
  }

  warn(message: string) {
    this.log(message, "warn");
  }

  error(message: string) {
    this.log(message, "error");
  }

  debug(message: string) {
    this.log(message, "debug");
  }
}

// --- 进度显示 ---
class ProgressTracker {
  private startTime: number;
  private intervalId?: NodeJS.Timeout;
  private logger: Logger;

  constructor() {
    this.startTime = Date.now();
    this.logger = Logger.getInstance();
  }

  startProgress(message: string) {
    this.logger.info(message);
    this.intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.logger.info(`⏳ 进行中... 已用时: ${elapsed} 秒`);
    }, 10000); // 每10秒显示一次进度
  }

  stopProgress() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    const totalTime = Math.floor((Date.now() - this.startTime) / 1000);
    this.logger.info(`✅ 完成! 总用时: ${totalTime} 秒`);
  }

  getElapsedTime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}

// --- 文件工具类 ---
class FileUtils {
  private static logger = Logger.getInstance();

  static async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch (error) {
      this.logger.error(`获取文件大小失败: ${filePath} - ${error}`);
      throw error;
    }
  }

  static async validateFiles(
    files: string[],
    maxFileSize: number,
    maxTotalSize: number
  ): Promise<{
    totalSize: number;
    warnings: string[];
  }> {
    let totalSize = 0;
    const warnings: string[] = [];

    for (const file of files) {
      try {
        const size = await this.getFileSize(file);
        totalSize += size;

        if (size > maxFileSize) {
          warnings.push(
            `文件 ${path.basename(file)} 过大 (${(size / 1024 / 1024).toFixed(
              2
            )} MB)`
          );
        }
      } catch (error) {
        this.logger.warn(`无法获取文件大小: ${file}`);
      }
    }

    if (totalSize > maxTotalSize) {
      warnings.push(
        `总文件大小过大 (${(totalSize / 1024 / 1024).toFixed(2)} MB)`
      );
    }

    return { totalSize, warnings };
  }

  static async createDirectory(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      this.logger.error(`创建目录失败: ${dirPath} - ${error}`);
      throw error;
    }
  }

  static async cleanupDirectory(dirPath: string): Promise<void> {
    try {
      if (existsSync(dirPath)) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    } catch (error) {
      this.logger.warn(`清理目录失败: ${dirPath} - ${error}`);
    }
  }
}

// --- Pinata 上传器类 ---
class PinataUploader {
  private pinata: PinataSDK;
  private config: Config;
  private logger: Logger;

  constructor(config: Config) {
    this.config = config;
    this.pinata = new PinataSDK({
      pinataJwt: config.pinataJwt,
      pinataGateway: config.pinataGateway,
    });
    this.logger = Logger.getInstance();
  }

  async testAuthentication(): Promise<boolean> {
    try {
      const result = await this.pinata.testAuthentication();
      this.logger.info("✅ Pinata 认证成功!");
      return true;
    } catch (error) {
      this.logger.error(`Pinata 认证失败: ${error}`);
      return false;
    }
  }

  async uploadDirectoryWithRetry(dirPath: string): Promise<string> {
    this.logger.info(`📁 正在上传文件夹: ${dirPath}`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const files = await this.readDirectoryFiles(dirPath);
        const totalSizeBytes = files.reduce((sum, file) => sum + file.size, 0);
        let sizeDisplay: string;
        if (totalSizeBytes < 1024) {
          sizeDisplay = `${totalSizeBytes} B`;
        } else if (totalSizeBytes < 1024 * 1024) {
          sizeDisplay = `${(totalSizeBytes / 1024).toFixed(2)} KB`;
        } else {
          sizeDisplay = `${(totalSizeBytes / 1024 / 1024).toFixed(2)} MB`;
        }
        this.logger.info(
          `📁 找到 ${files.length} 个文件，总大小: ${sizeDisplay}`
        );

        const progress = new ProgressTracker();
        progress.startProgress("🚀 开始上传到 Pinata...");

        try {
          const response = (await Promise.race([
            this.pinata.upload.public.fileArray(files),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error("上传超时，请检查网络连接或尝试压缩文件")),
                this.config.uploadTimeout
              )
            ),
          ])) as any;

          progress.stopProgress();
          this.logger.info(`✅ 文件夹上传成功! CID: ${response.cid}`);
          return response.cid;
        } catch (error) {
          progress.stopProgress();
          throw error;
        }
      } catch (error) {
        lastError = error as Error;
        this.logger.error(`第 ${attempt} 次上传失败: ${error}`);

        if (attempt < this.config.maxRetries) {
          this.logger.info(
            `⏳ ${this.config.retryDelay / 1000} 秒后重试... (${attempt}/${
              this.config.maxRetries
            })`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.retryDelay)
          );
        }
      }
    }

    this.logger.error(`上传失败，已重试 ${this.config.maxRetries} 次`);
    throw lastError;
  }

  async uploadSingleFile(
    filePath: string,
    options: { name?: string } = {}
  ): Promise<string> {
    this.logger.info(`📁 正在上传单个文件: ${filePath}`);

    try {
      const content = await fs.readFile(filePath);
      const fileName = options.name || path.basename(filePath);
      const file = new File([content], fileName, {
        type: this.getMimeType(fileName),
      });

      const response = await this.pinata.upload.public.file(file);
      this.logger.info(`✅ 单个文件上传成功! CID: ${response.cid}`);
      return response.cid;
    } catch (error) {
      this.logger.error(`单个文件上传失败: ${error}`);
      throw error;
    }
  }

  async uploadMetadata(metadata: any, fileName: string): Promise<string> {
    this.logger.info(`📄 正在上传元数据: ${fileName}`);

    try {
      const content = JSON.stringify(metadata, null, 2);
      const file = new File([content], fileName, {
        type: "application/json",
      });

      const response = await this.pinata.upload.public.file(file);
      this.logger.info(`✅ 元数据上传成功! CID: ${response.cid}`);
      return response.cid;
    } catch (error) {
      this.logger.error(`元数据上传失败: ${error}`);
      throw error;
    }
  }

  async pinByCid(cid: string): Promise<any> {
    this.logger.info(`📌 正在 Pin CID: ${cid}`);

    try {
      const response = await this.pinata.upload.public.cid(cid);
      this.logger.info(`✅ CID Pin 成功!`);
      return response;
    } catch (error) {
      this.logger.error(`CID Pin 失败: ${error}`);
      throw error;
    }
  }

  async checkPinQueue(): Promise<any> {
    this.logger.info(`📊 检查 Pin 队列状态`);

    try {
      const jobs = await this.pinata.files.public.queue().status("prechecking");
      this.logger.info(`✅ 队列状态获取成功!`);
      return jobs;
    } catch (error) {
      this.logger.error(`队列状态获取失败: ${error}`);
      throw error;
    }
  }

  async uploadTestFile(): Promise<string> {
    this.logger.info(`🧪 正在上传测试文件`);

    try {
      const testContent = "Hello Pinata! This is a test file.";
      const testFile = new File([testContent], "test.txt", {
        type: "text/plain",
      });

      const response = await this.pinata.upload.public.file(testFile);
      this.logger.info(`✅ 测试文件上传成功! CID: ${response.cid}`);
      return response.cid;
    } catch (error) {
      this.logger.error(`测试文件上传失败: ${error}`);
      throw error;
    }
  }

  private async readDirectoryFiles(dirPath: string): Promise<File[]> {
    const files: File[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.readDirectoryFiles(fullPath)));
      } else {
        const content = await fs.readFile(fullPath);
        const fileName = entry.name;
        const file = new File([content], fileName, {
          type: this.getMimeType(fileName),
        });
        files.push(file);
      }
    }
    return files;
  }

  private async readDirectoryFilesWithCustomName(
    dirPath: string,
    customName?: string
  ): Promise<File[]> {
    const files: File[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(
          ...(await this.readDirectoryFilesWithCustomName(fullPath, customName))
        );
      } else {
        const content = await fs.readFile(fullPath);
        const fileName = entry.name;
        const file = new File([content], fileName, {
          type: this.getMimeType(fileName),
        });
        files.push(file);
      }
    }
    return files;
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }
}

// --- 批量处理类 ---
class BatchProcessor {
  private uploader: PinataUploader;
  private config: Config;
  private logger: Logger;

  constructor(uploader: PinataUploader, config: Config) {
    this.uploader = uploader;
    this.config = config;
    this.logger = Logger.getInstance();
  }

  async processBatchCollection(
    generateBothVersions: boolean = true
  ): Promise<BatchUploadResult> {
    this.logger.info("🚀 开始处理批量 NFT 集合");

    const assetsDir = path.resolve(__dirname, "..", "..", "assets");
    const imagesInputDir = path.join(assetsDir, "batch_images");

    if (!existsSync(imagesInputDir)) {
      throw new Error(`❌ 输入目录不存在: ${imagesInputDir}`);
    }

    // 1. 上传图片文件夹
    this.logger.info("📁 正在上传图片文件夹...");
    const imagesFolderCid = await this.uploader.uploadDirectoryWithRetry(
      imagesInputDir
    );
    this.logger.info(`✅ 图片文件夹上传完成! CID: ${imagesFolderCid}`);
    this.logger.info(`📝 文件夹名称说明:`);
    this.logger.info(`   - Pinata 界面显示: 'folder_from_sdk' (SDK 默认行为)`);
    this.logger.info(`   - 实际访问路径: ipfs://${imagesFolderCid}/文件名`);
    this.logger.info(
      `   - 例如: ipfs://${imagesFolderCid}/1.png, ipfs://${imagesFolderCid}/2.png`
    );
    this.logger.info(
      `   - Gateway 访问: https://gateway.pinata.cloud/ipfs/${imagesFolderCid}/`
    );

    // 2. 生成元数据
    const imageFiles = (await fs.readdir(imagesInputDir)).filter((f) =>
      /\.(png|jpg|jpeg|gif)$/i.test(f)
    );

    // 验证文件
    const { totalSize, warnings } = await FileUtils.validateFiles(
      imageFiles.map((f) => path.join(imagesInputDir, f)),
      this.config.maxFileSize,
      this.config.maxTotalSize
    );

    warnings.forEach((warning) => this.logger.warn(warning));

    // 3. 生成元数据文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join(
      __dirname,
      "..",
      "output",
      `batch-upload-${timestamp}`
    );
    const resultsDir = path.join(outputDir, "results");

    await FileUtils.createDirectory(outputDir);
    await FileUtils.createDirectory(resultsDir);

    // 重新排序图片文件
    imageFiles.sort(
      (a, b) => parseInt(path.parse(a).name) - parseInt(path.parse(b).name)
    );

    let metadataWithSuffixCid: string | undefined;
    let metadataWithoutSuffixCid: string | undefined;

    if (generateBothVersions) {
      const { withSuffixCid, withoutSuffixCid } =
        await this.generateBothMetadataVersions(
          imageFiles,
          imagesFolderCid,
          outputDir
        );
      metadataWithSuffixCid = withSuffixCid;
      metadataWithoutSuffixCid = withoutSuffixCid;
    } else {
      metadataWithoutSuffixCid = await this.generateSingleMetadataVersion(
        imageFiles,
        imagesFolderCid,
        outputDir
      );
    }

    // 4. 保存结果
    const uploadResult: BatchUploadResult = {
      timestamp: new Date().toISOString(),
      imagesFolderCid,
      metadataWithSuffixCid,
      metadataWithoutSuffixCid,
      imageCount: imageFiles.length,
      metadataFiles: imageFiles.map((fileName) => ({
        tokenId: path.parse(fileName).name,
        metadataFileWithSuffix: `${path.parse(fileName).name}${
          this.config.metadataSuffix
        }`,
        metadataFileWithoutSuffix: `${path.parse(fileName).name}`,
      })),
      totalSize,
      uploadTime: Date.now(),
    };

    await this.saveResults(
      uploadResult,
      resultsDir,
      outputDir,
      generateBothVersions
    );

    this.logger.info("✨ 批量流程完成");
    this.logger.info(`📊 上传统计:`);
    this.logger.info(`   - 图片数量: ${uploadResult.imageCount}`);
    this.logger.info(`   - 图片文件夹 CID: ${uploadResult.imagesFolderCid}`);
    if (generateBothVersions) {
      this.logger.info(
        `   - 带${this.config.metadataSuffix}后缀元数据 CID: ${uploadResult.metadataWithSuffixCid}`
      );
      this.logger.info(
        `   - 不带后缀元数据 CID: ${uploadResult.metadataWithoutSuffixCid}`
      );
      this.logger.info(`📝 根据你的 NFT 合约需求选择 Base URI:`);
      this.logger.info(
        `   - 需要${this.config.metadataSuffix}后缀: ipfs://${uploadResult.metadataWithSuffixCid}/`
      );
      this.logger.info(
        `   - 不需要后缀: ipfs://${uploadResult.metadataWithoutSuffixCid}/`
      );
    } else {
      this.logger.info(
        `   - 不带后缀元数据 CID: ${uploadResult.metadataWithoutSuffixCid}`
      );
      this.logger.info(
        `📝 在合约中将 Base URI 设置为: ipfs://${uploadResult.metadataWithoutSuffixCid}/`
      );
    }
    this.logger.info(
      `📄 详细结果已保存到: ${path.join(resultsDir, "upload-result.json")}`
    );

    return uploadResult;
  }

  private async generateBothMetadataVersions(
    imageFiles: string[],
    imagesFolderCid: string,
    outputDir: string
  ): Promise<{ withSuffixCid: string; withoutSuffixCid: string }> {
    const metadataWithSuffixDir = path.join(outputDir, "metadata-json");
    const metadataWithoutSuffixDir = path.join(outputDir, "metadata");

    await FileUtils.cleanupDirectory(metadataWithSuffixDir);
    await FileUtils.cleanupDirectory(metadataWithoutSuffixDir);
    await FileUtils.createDirectory(metadataWithSuffixDir);
    await FileUtils.createDirectory(metadataWithoutSuffixDir);

    // 生成两种版本的元数据文件
    for (const fileName of imageFiles) {
      const tokenId = path.parse(fileName).name;
      const metadata = this.createMetadata(tokenId, imagesFolderCid, fileName);

      await fs.writeFile(
        path.join(
          metadataWithSuffixDir,
          `${tokenId}${this.config.metadataSuffix}`
        ),
        JSON.stringify(metadata, null, 2)
      );

      await fs.writeFile(
        path.join(metadataWithoutSuffixDir, `${tokenId}`),
        JSON.stringify(metadata, null, 2)
      );
    }

    this.logger.info(
      `📁 正在上传带${this.config.metadataSuffix}后缀的元数据文件夹...`
    );
    const withSuffixCid = await this.uploader.uploadDirectoryWithRetry(
      metadataWithSuffixDir
    );
    this.logger.info(
      `✅ 带${this.config.metadataSuffix}后缀元数据文件夹上传完成! CID: ${withSuffixCid}`
    );

    this.logger.info("📁 正在上传不带后缀的元数据文件夹...");
    const withoutSuffixCid = await this.uploader.uploadDirectoryWithRetry(
      metadataWithoutSuffixDir
    );
    this.logger.info(
      `✅ 不带后缀元数据文件夹上传完成! CID: ${withoutSuffixCid}`
    );

    // 清理临时文件夹
    await FileUtils.cleanupDirectory(metadataWithSuffixDir);
    await FileUtils.cleanupDirectory(metadataWithoutSuffixDir);

    return { withSuffixCid, withoutSuffixCid };
  }

  private async generateSingleMetadataVersion(
    imageFiles: string[],
    imagesFolderCid: string,
    outputDir: string
  ): Promise<string> {
    const metadataWithoutSuffixDir = path.join(outputDir, "metadata");

    await FileUtils.cleanupDirectory(metadataWithoutSuffixDir);
    await FileUtils.createDirectory(metadataWithoutSuffixDir);

    for (const fileName of imageFiles) {
      const tokenId = path.parse(fileName).name;
      const metadata = this.createMetadata(tokenId, imagesFolderCid, fileName);

      await fs.writeFile(
        path.join(metadataWithoutSuffixDir, `${tokenId}`),
        JSON.stringify(metadata, null, 2)
      );
    }

    this.logger.info("📁 正在上传不带后缀的元数据文件夹...");
    const withoutSuffixCid = await this.uploader.uploadDirectoryWithRetry(
      metadataWithoutSuffixDir
    );

    await FileUtils.cleanupDirectory(metadataWithoutSuffixDir);
    return withoutSuffixCid;
  }

  private createMetadata(
    tokenId: string,
    imagesFolderCid: string,
    fileName: string
  ) {
    return {
      name: `MetaCore #${tokenId}`,
      description: "MetaCore 集合中的一个独特成员。",
      image: `ipfs://${imagesFolderCid}/${fileName}`,
      attributes: [{ trait_type: "ID", value: parseInt(tokenId) }],
    };
  }

  private async saveResults(
    uploadResult: BatchUploadResult,
    resultsDir: string,
    outputDir: string,
    generateBothVersions: boolean
  ): Promise<void> {
    const resultFilePath = path.join(resultsDir, "upload-result.json");
    await fs.writeFile(resultFilePath, JSON.stringify(uploadResult, null, 2));
    this.logger.info(`📄 上传结果已保存到: ${resultFilePath}`);

    const readmeContent = this.generateReadmeContent(
      uploadResult,
      generateBothVersions
    );
    const readmePath = path.join(outputDir, "README.md");
    await fs.writeFile(readmePath, readmeContent);
    this.logger.info(`📄 说明文档已保存到: ${readmePath}`);
  }

  private generateReadmeContent(
    uploadResult: BatchUploadResult,
    generateBothVersions: boolean
  ): string {
    return `# Pinata 批量上传结果

## 📅 上传时间
${new Date().toLocaleString()}

## 📊 上传统计
- 图片数量: ${uploadResult.imageCount}
- 图片文件夹 CID: ${uploadResult.imagesFolderCid}
${
  generateBothVersions
    ? `- 带${this.config.metadataSuffix}后缀元数据文件夹 CID: ${uploadResult.metadataWithSuffixCid}
- 不带后缀元数据文件夹 CID: ${uploadResult.metadataWithoutSuffixCid}
- 文件格式: 带${this.config.metadataSuffix}后缀 + 不带后缀（兼容所有 NFT 合约）`
    : `- 不带后缀元数据文件夹 CID: ${uploadResult.metadataWithoutSuffixCid}
- 文件格式: 不带后缀（标准 NFT 合约格式）`
}

## 🔗 访问链接
${
  generateBothVersions
    ? `- 带${this.config.metadataSuffix}后缀 Base URI: ipfs://${uploadResult.metadataWithSuffixCid}/
- 不带后缀 Base URI: ipfs://${uploadResult.metadataWithoutSuffixCid}/
- 带${this.config.metadataSuffix}后缀 Gateway: https://gateway.pinata.cloud/ipfs/${uploadResult.metadataWithSuffixCid}/
- 不带后缀 Gateway: https://gateway.pinata.cloud/ipfs/${uploadResult.metadataWithoutSuffixCid}/`
    : `- Base URI: ipfs://${uploadResult.metadataWithoutSuffixCid}/
- Gateway URL: https://gateway.pinata.cloud/ipfs/${uploadResult.metadataWithoutSuffixCid}/`
}

## 🚀 使用方法
${
  generateBothVersions
    ? `根据你的 NFT 合约需求选择：
- 需要${this.config.metadataSuffix}后缀: 使用 \`ipfs://${uploadResult.metadataWithSuffixCid}/\`
- 不需要后缀: 使用 \`ipfs://${uploadResult.metadataWithoutSuffixCid}/\``
    : `在智能合约中设置 Base URI 为: \`ipfs://${uploadResult.metadataWithoutSuffixCid}/\``
}
`;
  }
}

// --- 单个文件处理类 ---
class SingleFileProcessor {
  private uploader: PinataUploader;
  private logger: Logger;

  constructor(uploader: PinataUploader) {
    this.uploader = uploader;
    this.logger = Logger.getInstance();
  }

  async processSingleFile(): Promise<SingleUploadResult> {
    this.logger.info("🚀 开始处理单个文件上传");

    const assetsDir = path.resolve(__dirname, "..", "..", "assets");
    const singleImageDir = path.join(assetsDir, "image");

    if (!existsSync(singleImageDir)) {
      throw new Error(`⚠️  图片目录不存在: ${singleImageDir}`);
    }

    const imageFiles = (await fs.readdir(singleImageDir)).filter((f) =>
      /\.(png|jpg|jpeg|gif)$/i.test(f)
    );

    if (imageFiles.length === 0) {
      throw new Error("⚠️  image 目录下没有找到图片文件");
    }

    const firstImage = imageFiles[0];
    const singleImagePath = path.join(singleImageDir, firstImage);
    const imageName = path.parse(firstImage).name;
    this.logger.info(`📁 选择图片进行测试: ${firstImage}`);

    const imageCid = await this.uploader.uploadSingleFile(singleImagePath);

    const metadata = {
      name: `MetaCore #${imageName}`,
      description: "单个 NFT 示例",
      image: `ipfs://${imageCid}`,
      attributes: [{ trait_type: "Type", value: "Single" }],
    };

    const metadataFileName = `${imageName}-metadata.json`;
    const metadataCid = await this.uploader.uploadMetadata(
      metadata,
      metadataFileName
    );

    const uploadResult: SingleUploadResult = {
      timestamp: new Date().toISOString(),
      imageCid,
      metadataCid,
      imageUrl: `ipfs://${imageCid}`,
      metadataUrl: `ipfs://${metadataCid}`,
      gatewayImageUrl: `https://gateway.pinata.cloud/ipfs/${imageCid}`,
      gatewayMetadataUrl: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
      metadata,
      uploadTime: Date.now(),
    };

    await this.saveSingleFileResults(uploadResult);

    return uploadResult;
  }

  private async saveSingleFileResults(
    uploadResult: SingleUploadResult
  ): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join(
      __dirname,
      "..",
      "output",
      `single-upload-${timestamp}`
    );
    const resultsDir = path.join(outputDir, "results");

    await FileUtils.createDirectory(outputDir);
    await FileUtils.createDirectory(resultsDir);

    const singleResultFilePath = path.join(resultsDir, "upload-result.json");
    await fs.writeFile(
      singleResultFilePath,
      JSON.stringify(uploadResult, null, 2)
    );
    this.logger.info(`📄 单个文件上传结果已保存到: ${singleResultFilePath}`);

    const readmeContent = this.generateSingleFileReadme(uploadResult);
    const readmePath = path.join(outputDir, "README.md");
    await fs.writeFile(readmePath, readmeContent);
    this.logger.info(`📄 说明文档已保存到: ${readmePath}`);
  }

  private generateSingleFileReadme(uploadResult: SingleUploadResult): string {
    return `# Pinata 单个文件上传结果

## 📅 上传时间
${new Date().toLocaleString()}

## 📊 上传信息
- 图片 CID: ${uploadResult.imageCid}
- 元数据 CID: ${uploadResult.metadataCid}

## 🔗 访问链接
- 图片: https://gateway.pinata.cloud/ipfs/${uploadResult.imageCid}
- 元数据: https://gateway.pinata.cloud/ipfs/${uploadResult.metadataCid}

## 📁 文件结构
\`\`\`
${path.dirname(uploadResult.gatewayImageUrl)}/
├── results/
│   └── upload-result.json     # 详细上传结果
└── README.md                  # 说明文档
\`\`\`
`;
  }
}

// --- 主程序 ---
async function main() {
  const startTime = Date.now();
  const logger = Logger.getInstance();

  try {
    // 1. 加载配置
    const configManager = new ConfigManager();
    const config = configManager.getConfig();

    // 2. 初始化上传器
    const uploader = new PinataUploader(config);

    // 3. 测试认证
    const authSuccess = await uploader.testAuthentication();
    if (!authSuccess) {
      logger.error("Pinata 认证失败，程序退出");
      return;
    }

    // 4. 解析命令行参数
    const mode = process.argv[2] || "batch";
    const noSuffix = process.argv.includes("--no-suffix");

    logger.info("📋 上传模式说明:");
    logger.info("  🎯 single: 单个文件模式 - 上传单个图片 + 单个 JSON");
    logger.info("  📦 batch: 批量模式 - 上传整个文件夹 + 批量 JSON");
    logger.info("  🧪 test: 测试模式 - 上传测试文件");
    logger.info("  📌 pin: Pin by CID 模式");
    logger.info("  📊 queue: 检查 Pin 队列状态");

    // 5. 执行相应的模式
    switch (mode) {
      case "single":
        logger.info("🎯 选择: 单个文件模式");
        const singleProcessor = new SingleFileProcessor(uploader);
        await singleProcessor.processSingleFile();
        break;

      case "test":
        logger.info("🧪 选择: 测试模式");
        await uploader.uploadTestFile();
        break;

      case "pin":
        logger.info("📌 选择: Pin by CID 模式");
        const cid = process.argv[3];
        if (!cid) {
          logger.error("❌ 请提供 CID 参数，例如: pnpm pin <CID>");
          return;
        }
        await uploader.pinByCid(cid);
        break;

      case "queue":
        logger.info("📊 选择: 检查队列状态");
        await uploader.checkPinQueue();
        break;

      default:
        logger.info("📦 选择: 批量模式");
        const batchProcessor = new BatchProcessor(uploader, config);

        if (noSuffix) {
          logger.info("📝 模式: 只生成不带后缀的元数据文件");
          await batchProcessor.processBatchCollection(false);
        } else {
          logger.info(
            `📝 模式: 生成带${config.metadataSuffix}后缀和不带后缀的元数据文件`
          );
          await batchProcessor.processBatchCollection(true);
        }
        break;
    }
  } catch (error) {
    logger.error(`脚本执行失败: ${error}`);
    process.exit(1);
  } finally {
    const totalTime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`脚本总执行时间: ${totalTime} 秒`);
    logger.info("🎉 脚本执行完成，正在退出...");
    process.exit(0);
  }
}

// 如果直接运行此文件，则执行主程序
if (require.main === module) {
  main();
}

export {
  ConfigManager,
  Logger,
  ProgressTracker,
  FileUtils,
  PinataUploader,
  BatchProcessor,
  SingleFileProcessor,
  type UploadResult,
  type BatchUploadResult,
  type SingleUploadResult,
  type Config,
};
