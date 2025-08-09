use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use clap::{Parser, Subcommand};
use dotenvy::dotenv;
use pinata_sdk::{PinByFile, PinataApi};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::timeout;
use tokio_retry::Retry;
use tokio_retry::strategy::{ExponentialBackoff, jitter};
use tracing::{Level, error, info, warn};
use tracing_subscriber;

// --- 配置 ---
const MAX_RETRIES: usize = 3;
const RETRY_DELAY_MS: u64 = 5000;
const UPLOAD_TIMEOUT_SECONDS: u64 = 300; // 5分钟超时

// --- 文件格式配置 ---
const METADATA_FILE_SUFFIX: &str = ""; // 默认不带后缀，符合标准NFT格式
const SUPPORTED_METADATA_FORMATS: [&str; 4] = ["", ".json", ".yaml", ".yml"]; // 支持的格式列表，包括空字符串

// --- 获取配置的函数 ---
fn get_metadata_file_suffix() -> String {
    // 优先从环境变量读取
    if let Ok(suffix) = env::var("METADATA_FILE_SUFFIX") {
        // 验证格式是否支持
        if SUPPORTED_METADATA_FORMATS.contains(&suffix.as_str()) {
            return suffix;
        } else {
            warn!(
                "⚠️  Unsupported metadata format: {}, using default: {}",
                suffix, METADATA_FILE_SUFFIX
            );
        }
    }

    // 如果没有环境变量或格式不支持，使用默认值
    METADATA_FILE_SUFFIX.to_string()
}

// --- 数据结构 ---
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Attribute {
    trait_type: String,
    value: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct NftMetadata {
    name: String,
    description: String,
    image: String,
    attributes: Vec<Attribute>,
}

// --- 命令行接口定义 ---
#[derive(Parser, Debug)]
#[command(author, version, about = "A production-grade NFT metadata upload tool (Rust version)", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Batch processing mode
    #[command(name = "batch")]
    Batch {
        /// Generate both versions (with and without suffix)
        #[arg(long)]
        both_versions: bool,
    },
    /// Single file processing mode
    #[command(name = "single")]
    Single {
        /// Token ID for the NFT
        #[arg(long)]
        token_id: Option<u64>,
    },
    /// Test mode
    #[command(name = "test")]
    Test,
    /// Pin file by CID
    #[command(name = "pin")]
    Pin {
        #[arg(required = true)]
        cid: String,
    },
    /// Check pin queue status
    #[command(name = "queue")]
    Queue,
}

// --- 核心上传函数 (带重试和超时) ---
async fn upload_directory_with_retry(api: &PinataApi, dir_path: &Path) -> Result<String> {
    let retry_strategy = ExponentialBackoff::from_millis(RETRY_DELAY_MS)
        .map(jitter)
        .take(MAX_RETRIES);
    info!(
        "🔄 Starting upload with retry mechanism (max {} attempts)",
        MAX_RETRIES
    );
    let result = Retry::spawn(retry_strategy, || async {
        let upload_future = upload_directory_to_pinata(api, dir_path);
        timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECONDS), upload_future).await?
    })
    .await;
    match result {
        Ok(cid) => {
            info!("✅ Upload completed successfully after retries");
            Ok(cid)
        }
        Err(e) => {
            error!("❌ Upload failed after {} attempts: {}", MAX_RETRIES, e);
            Err(e)
        }
    }
}

async fn upload_directory_to_pinata(api: &PinataApi, dir_path: &Path) -> Result<String> {
    let path_str = dir_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid folder path"))?;

    let upload_start = std::time::Instant::now();
    info!("--- Uploading folder to Pinata: {} ---", path_str);
    info!(
        "⏱️  Upload started at: {}",
        chrono::Utc::now().format("%H:%M:%S")
    );

    let pin_obj = PinByFile::new(path_str);
    let res = api
        .pin_file(pin_obj)
        .await
        .map_err(|e| anyhow!("Upload failed: {}", e))?;

    let upload_duration = upload_start.elapsed();
    let cid = res.ipfs_hash;

    info!("✅ Folder uploaded successfully! CID: {}", cid);
    info!(
        "⏱️  Upload completed in: {:.2} seconds",
        upload_duration.as_secs_f64()
    );

    Ok(cid)
}

async fn upload_single_file_to_pinata(api: &PinataApi, file_path: &Path) -> Result<String> {
    let path_str = file_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid file path"))?;

    let upload_start = std::time::Instant::now();
    let file_size = fs::metadata(file_path)?.len();
    let file_size_mb = file_size as f64 / 1024.0 / 1024.0;

    info!("--- Uploading single file to Pinata: {} ---", path_str);
    info!(
        "⏱️  Upload started at: {}",
        chrono::Utc::now().format("%H:%M:%S")
    );
    info!("📁 File size: {:.2} MB", file_size_mb);

    let pin_obj = PinByFile::new(path_str);
    let res = api
        .pin_file(pin_obj)
        .await
        .map_err(|e| anyhow!("Upload failed: {}", e))?;

    let upload_duration = upload_start.elapsed();
    let upload_speed = file_size_mb / upload_duration.as_secs_f64();
    let cid = res.ipfs_hash;

    info!("✅ File uploaded successfully! CID: {}", cid);
    info!(
        "⏱️  Upload completed in: {:.2} seconds",
        upload_duration.as_secs_f64()
    );
    info!("📊 Upload speed: {:.2} MB/s", upload_speed);

    Ok(cid)
}

// --- 工作流 ---
async fn process_batch_collection(api: &PinataApi, generate_both_versions: bool) -> Result<()> {
    info!("==============================================");
    info!("🚀 Starting batch NFT collection processing (Pinata)...");
    info!("==============================================");

    let assets_dir = PathBuf::from("assets");
    let images_input_dir = assets_dir.join("batch_images");
    if !images_input_dir.exists() {
        return Err(anyhow!(
            "❌ Input directory does not exist: {:?}",
            images_input_dir
        ));
    }

    let images_folder_cid = upload_directory_with_retry(api, &images_input_dir).await?;
    info!("\n🖼️  Images folder CID obtained: {}", images_folder_cid);

    let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
    let output_dir = PathBuf::from("output").join(format!("batch-upload-{}", timestamp));
    let results_dir = output_dir.join("results");
    fs::create_dir_all(&results_dir)?;

    let image_files: Vec<PathBuf> = fs::read_dir(&images_input_dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();

    let (metadata_with_suffix_cid, metadata_without_suffix_cid, metadata_dir) =
        if generate_both_versions {
            let (cid_with, cid_without, dir) =
                generate_and_upload_both_versions(api, &image_files, &images_folder_cid).await?;
            (Some(cid_with), Some(cid_without), Some(dir))
        } else {
            // 单版本生成时，根据环境变量决定是否带后缀
            let should_use_suffix = !get_metadata_file_suffix().is_empty();
            let (cid, dir) = generate_and_upload_single_version(
                api,
                &image_files,
                &images_folder_cid,
                should_use_suffix,
            )
            .await?;
            (None, Some(cid), Some(dir))
        };

    save_batch_results(
        &output_dir,
        &images_folder_cid,
        metadata_with_suffix_cid.as_deref(),
        metadata_without_suffix_cid.as_deref(),
        image_files.len(),
        metadata_dir.as_deref(),
    )
    .await?;

    info!("\n--- ✨ Batch process completed ✨ ---");
    if let Some(cid) = metadata_without_suffix_cid {
        info!(
            "Next step (no suffix), you can set Base URI in contract to: ipfs://{}/",
            cid
        );
    }
    if let Some(cid) = metadata_with_suffix_cid {
        info!(
            "Next step (with suffix), you can set Base URI in contract to: ipfs://{}/",
            cid
        );
    }

    Ok(())
}

async fn generate_and_upload_both_versions(
    api: &PinataApi,
    image_files: &[PathBuf],
    images_folder_cid: &str,
) -> Result<(String, String, PathBuf)> {
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();

    // Create separate directories for each version
    let metadata_dir_with_suffix =
        PathBuf::from("output").join(format!("batch_images-metadata-with-suffix-{}", timestamp));
    let metadata_dir_without_suffix = PathBuf::from("output").join(format!(
        "batch_images-metadata-without-suffix-{}",
        timestamp
    ));

    // Create version with suffix
    create_metadata_files(
        image_files,
        &metadata_dir_with_suffix,
        images_folder_cid,
        true, // with suffix
        true, // is_dual_version
    )
    .await?;

    info!("📁 Uploading metadata folder with suffix...");
    let cid_with = upload_directory_with_retry(api, &metadata_dir_with_suffix).await?;

    // Create version without suffix
    create_metadata_files(
        image_files,
        &metadata_dir_without_suffix,
        images_folder_cid,
        false, // without suffix
        true,  // is_dual_version
    )
    .await?;

    info!("📁 Uploading metadata folder without suffix...");
    let cid_without = upload_directory_with_retry(api, &metadata_dir_without_suffix).await?;

    // Clean up the with-suffix directory, keep the without-suffix for local save
    fs::remove_dir_all(&metadata_dir_with_suffix)?;

    Ok((cid_with, cid_without, metadata_dir_without_suffix))
}

async fn generate_and_upload_single_version(
    api: &PinataApi,
    image_files: &[PathBuf],
    images_folder_cid: &str,
    with_suffix: bool,
) -> Result<(String, PathBuf)> {
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let metadata_dir = PathBuf::from("output").join(format!("batch_images-metadata-{}", timestamp));

    create_metadata_files(
        image_files,
        &metadata_dir,
        images_folder_cid,
        with_suffix,
        false,
    )
    .await?;

    info!("📁 Uploading metadata folder...");
    let cid = upload_directory_with_retry(api, &metadata_dir).await?;

    // Don't remove the directory, we'll save it
    Ok((cid, metadata_dir))
}

async fn create_metadata_files(
    image_files: &[PathBuf],
    dir: &Path,
    images_folder_cid: &str,
    with_suffix: bool,
    is_dual_version: bool,
) -> Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::create_dir_all(dir)?;

    for image_file in image_files {
        let token_id_str = image_file
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("Invalid filename"))?;
        let token_id: u64 = token_id_str.parse()?;
        let image_filename = image_file
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("Invalid filename"))?;

        let metadata = NftMetadata {
            name: format!("MetaCore #{}", token_id),
            description: "A unique member of the MetaCore collection.".to_string(),
            image: format!("ipfs://{}/{}", images_folder_cid, image_filename),
            attributes: vec![Attribute {
                trait_type: "ID".to_string(),
                value: token_id.into(),
            }],
        };

        let file_name = if with_suffix {
            if is_dual_version {
                // 双版本生成时，带后缀版本固定使用 .json
                format!("{}.json", token_id_str)
            } else {
                // 单版本生成时，使用环境变量设置的后缀
                format!("{}{}", token_id_str, get_metadata_file_suffix())
            }
        } else {
            // 不带后缀版本，始终不带后缀
            token_id_str.to_string()
        };

        let file_path = dir.join(&file_name);
        let mut file = File::create(&file_path)?;
        file.write_all(serde_json::to_string_pretty(&metadata)?.as_bytes())?;
        file.flush()?;
        drop(file);

        info!("📄 Created metadata file: {}", file_path.to_string_lossy());
    }

    // Verify files were created and are readable
    let files_in_dir: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
    info!(
        "📁 Created {} metadata files in: {}",
        files_in_dir.len(),
        dir.to_string_lossy()
    );

    // Verify each file is readable and has content
    for file_entry in &files_in_dir {
        let file_path = &file_entry.path();
        let file_size = fs::metadata(file_path)?.len();
        let content = fs::read_to_string(file_path)?;
        info!(
            "✅ File {} is readable, size: {} bytes, content length: {} bytes",
            file_path.to_string_lossy(),
            file_size,
            content.len()
        );
    }

    // Additional verification: check folder size before upload
    let folder_size = calculate_folder_size(dir)?;
    let folder_size_mb = folder_size as f64 / 1024.0 / 1024.0;
    info!(
        "📁 Metadata folder size before upload: {:.2} MB ({} bytes)",
        folder_size_mb, folder_size
    );

    // Force filesystem sync before upload
    if let Ok(_) = std::process::Command::new("sync").output() {
        info!("📁 Filesystem sync completed");
    }

    Ok(())
}

fn calculate_folder_size(dir_path: &Path) -> Result<u64> {
    let mut total_size = 0u64;

    for entry in fs::read_dir(dir_path)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() {
            let file_size = fs::metadata(&path)?.len();
            total_size += file_size;
        } else if path.is_dir() {
            total_size += calculate_folder_size(&path)?;
        }
    }

    Ok(total_size)
}

async fn save_batch_results(
    output_dir: &Path,
    images_cid: &str,
    metadata_with_suffix_cid: Option<&str>,
    metadata_without_suffix_cid: Option<&str>,
    total_files: usize,
    metadata_dir: Option<&Path>,
) -> Result<()> {
    let results = serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "images_cid": images_cid,
        "metadata_with_suffix_cid": metadata_with_suffix_cid,
        "metadata_without_suffix_cid": metadata_without_suffix_cid,
        "total_files": total_files,
        "status": "completed"
    });

    let results_file = output_dir.join("results").join("upload-result.json");
    let mut file = File::create(&results_file)?;
    file.write_all(serde_json::to_string_pretty(&results)?.as_bytes())?;

    // Copy metadata folder if provided
    if let Some(metadata_src) = metadata_dir {
        let metadata_dest = output_dir.join("metadata");
        if metadata_src.exists() {
            if metadata_dest.exists() {
                fs::remove_dir_all(&metadata_dest)?;
            }
            fs::create_dir_all(&metadata_dest)?;

            // Copy all files from metadata directory
            for entry in fs::read_dir(metadata_src)? {
                let entry = entry?;
                let src_path = entry.path();
                let dest_path = metadata_dest.join(src_path.file_name().unwrap());

                if src_path.is_file() {
                    fs::copy(&src_path, &dest_path)?;
                    info!("📄 Copied metadata file: {}", dest_path.to_string_lossy());
                }
            }
            info!("📁 Metadata folder saved to: {:?}", metadata_dest);
        }
    }

    let readme_content = format!(
        "# Batch Upload Results

## Upload Information
- **Timestamp**: {}
- **Images CID**: `{}`
- **Metadata with suffix CID**: `{}`
- **Metadata without suffix CID**: `{}`
- **Total files**: {}

## Usage
- For contracts expecting .json suffix: Use `ipfs://{}/`
- For contracts without suffix: Use `ipfs://{}/`

## Files
- Images are available at: `ipfs://{}/`
- Metadata files are available at the respective CIDs above.
- Local metadata files are saved in the `metadata/` folder for reference.
",
        chrono::Utc::now().to_rfc3339(),
        images_cid,
        metadata_with_suffix_cid.unwrap_or("N/A"),
        metadata_without_suffix_cid.unwrap_or("N/A"),
        total_files,
        metadata_with_suffix_cid.unwrap_or(""),
        metadata_without_suffix_cid.unwrap_or(""),
        images_cid
    );

    let readme_file = output_dir.join("README.md");
    let mut readme = File::create(&readme_file)?;
    readme.write_all(readme_content.as_bytes())?;

    info!("✅ Results saved to: {:?}", output_dir);
    Ok(())
}

async fn process_single_file(api: &PinataApi, token_id: Option<u64>) -> Result<()> {
    info!("==============================================");
    info!("🚀 Starting single file processing (Pinata)...");
    info!("==============================================");

    let assets_dir = PathBuf::from("assets");
    let image_dir = assets_dir.join("image");
    if !image_dir.exists() {
        return Err(anyhow!(
            "❌ Image directory does not exist: {:?}",
            image_dir
        ));
    }

    let image_files: Vec<PathBuf> = fs::read_dir(&image_dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();

    if image_files.is_empty() {
        return Err(anyhow!("❌ No image files found in {:?}", image_dir));
    }

    let image_file = &image_files[0];
    info!("📁 Uploading image file: {}", image_file.display());
    let image_cid = upload_single_file_to_pinata(api, image_file).await?;
    info!("✅ Image uploaded successfully! CID: {}", image_cid);

    let token_id = token_id.unwrap_or(1);
    let metadata = NftMetadata {
        name: format!("MetaCore #{}", token_id),
        description: "A unique member of the MetaCore collection.".to_string(),
        image: format!("ipfs://{}", image_cid),
        attributes: vec![Attribute {
            trait_type: "ID".to_string(),
            value: token_id.into(),
        }],
    };

    let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
    let output_dir = PathBuf::from("output").join(format!("single-upload-{}", timestamp));
    let results_dir = output_dir.join("results");
    fs::create_dir_all(&results_dir)?;

    // 简化：只创建和上传一个元数据文件
    let base_filename = image_file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("Invalid filename"))?;

    // 为了便于管理，我们给本地备份文件一个 .json 后缀，但上传时可以指定不带后缀的名字
    let local_metadata_path = output_dir.join(format!("{}.json", base_filename));
    let mut file = File::create(&local_metadata_path)?;
    file.write_all(serde_json::to_string_pretty(&metadata)?.as_bytes())?;

    info!(
        "📄 Created local metadata file: {}",
        local_metadata_path.display()
    );
    info!("📁 Uploading metadata file...");

    // 上传这个文件，并获得其最终的、唯一的CID
    let metadata_cid = upload_single_file_to_pinata(api, &local_metadata_path).await?;
    info!("✅ Metadata uploaded successfully! CID: {}", metadata_cid);

    // 简化结果保存
    let results_dir = output_dir.join("results");
    fs::create_dir_all(&results_dir)?;

    let results = serde_json::json!({
        "image_cid": image_cid,
       "metadata_cid": metadata_cid, // 只记录一个CID
        "status": "completed",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "token_id": token_id
    });

    let results_file = results_dir.join("upload-result.json");
    let mut file = File::create(&results_file)?;
    file.write_all(serde_json::to_string_pretty(&results)?.as_bytes())?;

    // 简化README内容
    let readme_content = format!(
        "# Single File Upload Results

## Upload Information
- **Timestamp**: {}
- **Image CID**: `{}`
- **Metadata CID**: `{}`
- **Token ID**: {}

## Usage
- The Token URI for this NFT is: `ipfs://{}`

## Files
- Image is available at: `https://gateway.pinata.cloud/ipfs/{}`
- Metadata is available at: `https://gateway.pinata.cloud/ipfs/{}`
",
        chrono::Utc::now().to_rfc3339(),
        image_cid,
        metadata_cid,
        token_id,
        metadata_cid, // Token URI
        image_cid,    // Gateway link for image
        metadata_cid  // Gateway link for metadata
    );

    let readme_file = output_dir.join("README.md");
    let mut readme = File::create(&readme_file)?;
    readme.write_all(readme_content.as_bytes())?;

    info!("✅ Results saved to: {:?}", output_dir);
    info!("\n--- ✨ Single file process completed ✨ ---");
    info!(
        "Next step, you can set Token URI in contract to: ipfs://{}",
        metadata_cid
    );

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_max_level(Level::INFO).init();
    let start_time = std::time::Instant::now();

    dotenv().ok();
    let api_key = env::var("PINATA_API_KEY").context("Please set PINATA_API_KEY in .env file")?;
    let secret_key =
        env::var("PINATA_SECRET_KEY").context("Please set PINATA_SECRET_KEY in .env file")?;

    let api = PinataApi::new(&api_key, &secret_key)
        .map_err(|e| anyhow!("Pinata API initialization failed: {}", e))?;
    api.test_authentication()
        .await
        .map_err(|e| anyhow!("Pinata authentication failed: {}", e))?;
    info!("✅ Pinata authentication successful!");

    let cli = Cli::parse();
    if let Err(e) = match cli.command {
        Commands::Batch { both_versions, .. } => {
            process_batch_collection(&api, both_versions).await
        }
        Commands::Single { token_id, .. } => process_single_file(&api, token_id).await,
        _ => {
            warn!("This command is not implemented yet");
            Ok(())
        }
    } {
        error!("❌ Script execution failed: {:?}", e);
    }

    info!("Total script execution time: {:?}", start_time.elapsed());
    Ok(())
}
