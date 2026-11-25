import { 
  FileCode, Terminal, Code, Binary, Database, Settings, Server, Wrench, Box,
  FileJson, Container, Shapes, 
  Video, Camera, Clapperboard, MonitorPlay, Image as ImageIcon, 
  Palette, 
  Music, Headphones, Mic, Radio,
  Archive, Disc, AppWindow,
  Type, PenTool, Book, Library,
  FileText, Table,
  File, Folder
} from 'lucide-react';

export function getStandardFileColor(filename: string, mimeType: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const isDir = mimeType === 'application/vnd.telegram.folder';
  
  if (isDir) return 'text-blue-500 dark:text-blue-400';

  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return 'text-rose-600 dark:text-rose-500';
  }

  if (['doc', 'docx', 'rtf', 'odt', 'dot', 'dotx', 'docm'].includes(ext) || mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml')) {
    return 'text-blue-600 dark:text-blue-400';
  }

  if (['xls', 'xlsx', 'csv', 'ods', 'tsv', 'xlsm'].includes(ext) || mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
    return 'text-emerald-600 dark:text-emerald-500';
  }

  if (['ppt', 'pptx', 'odp', 'key', 'pps', 'pptm'].includes(ext) || mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
    return 'text-orange-500 dark:text-orange-400';
  }

  if (['txt', 'md', 'log', 'tex', 'rst', 'nfo'].includes(ext) || mimeType.startsWith('text/')) {
    return 'text-sky-600 dark:text-sky-400';
  }

  if (['mp4', 'm4v', 'mkv', 'webm', 'mov', 'qt', 'avi', 'ts', 'm2ts', 'mts', 'flv', 'f4v', 'swf', 'wmv', 'asf', 'ogv', '3gp', '3g2', 'prores', 'dnxhd'].includes(ext) || mimeType.startsWith('video/')) {
    return 'text-rose-500 dark:text-rose-400';
  }

  if (['mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'wave', 'flac', 'alac', 'aiff', 'aif', 'wma', 'amr', '3ga', 'm4b', 'dsd', 'mid', 'midi'].includes(ext) || mimeType.startsWith('audio/')) {
    return 'text-amber-500 dark:text-amber-400';
  }

  if (['svg', 'ai', 'eps', 'cdr'].includes(ext) || mimeType.includes('svg')) {
    return 'text-amber-600 dark:text-amber-400';
  }

  if (['psd', 'psb', 'indd', 'xcf', 'sketch', 'fig'].includes(ext)) {
    return 'text-sky-500 dark:text-sky-400';
  }

  if (['jpeg', 'jpg', 'jfif', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'dib', 'tga', 'dds', 'jxl', 'raw', 'dng', 'cr3', 'nef', 'arw', 'ico'].includes(ext) || mimeType.startsWith('image/')) {
    return 'text-violet-500 dark:text-violet-400';
  }

  if (['zip', 'rar', 'rev', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz', 'z', 'tgz', 'tbz2'].includes(ext) || mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('tar') || mimeType.includes('7z')) {
    return 'text-purple-600 dark:text-purple-400';
  }

  if (['iso', 'img', 'dmg', 'vhd', 'vhdx', 'vmdk', 'vdi'].includes(ext)) {
    return 'text-cyan-600 dark:text-cyan-400';
  }

  if (['exe', 'com', 'msi', 'msix', 'app', 'apk', 'aab', 'ipa', 'deb', 'rpm'].includes(ext)) {
    return 'text-indigo-600 dark:text-indigo-400';
  }

  if (['sh', 'bash', 'zsh', 'csh', 'ksh', 'ps1', 'psm1', 'bat', 'cmd'].includes(ext)) {
    return 'text-emerald-500 dark:text-emerald-400';
  }

  if (['html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less'].includes(ext)) {
    return 'text-orange-600 dark:text-orange-400';
  }

  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'text-amber-400 dark:text-amber-300';
  if (['ts', 'tsx'].includes(ext)) return 'text-blue-500 dark:text-blue-400';
  if (['py', 'pyc', 'pyw', 'pyd'].includes(ext)) return 'text-sky-500 dark:text-sky-400';
  if (['rs', 'go', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'swift', 'kt', 'php', 'rb'].includes(ext)) return 'text-teal-600 dark:text-teal-400';

  if (['json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml'].includes(ext)) {
    return 'text-amber-500 dark:text-amber-400';
  }

  if (['sql', 'db', 'sqlite', 'prisma', 'graphql', 'gql'].includes(ext)) {
    return 'text-teal-500 dark:text-teal-400';
  }

  if (['epub', 'mobi', 'azw3', 'cbr', 'cbz'].includes(ext)) {
    return 'text-amber-700 dark:text-amber-500';
  }

  if (['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext)) {
    return 'text-fuchsia-500 dark:text-fuchsia-400';
  }

  if (['obj', 'fbx', 'stl', 'gltf', 'glb', 'blend', 'max', '3ds', 'dwg', 'dxf'].includes(ext)) {
    return 'text-cyan-600 dark:text-cyan-400';
  }

  return 'text-blue-500 dark:text-blue-400';
}

export function getFileIcon(filename: string, mimeType: string, className: string = "w-6 h-6") {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const isDir = mimeType === 'application/vnd.telegram.folder';
  
  const hasColor = /\btext-(?:\[#|[a-z]+-\d+|white|black)/.test(className);
  const colorClass = hasColor ? '' : getStandardFileColor(filename, mimeType);
  const iconClass = colorClass ? `${className} ${colorClass}` : className;
  
  if (isDir) return <Folder className={iconClass} />;

  // 1. Source Code & Scripts
  if (['sh', 'bash', 'zsh', 'csh', 'ksh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd'].includes(ext)) return <Terminal className={iconClass} />;
  if (['lua', 'pl', 'pm', 't', 'rb', 'rbw', 'rake', 'php', 'phtml', 'py', 'pyc', 'pyw', 'pyd', 'java', 'class', 'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hxx', 'cs', 'csx', 'go', 'rs', 'kt', 'kts', 'swift', 'dart', 'r', 'rmd', 'ts', 'tsx', 'jsx', 'vue', 'svelte'].includes(ext)) return <FileCode className={iconClass} />;
  if (['html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'xml', 'xsd', 'xslt', 'asm', 's', 'awk', 'sed'].includes(ext)) return <Code className={iconClass} />;
  if (['sql', 'prisma', 'graphql', 'gql'].includes(ext)) return <Database className={iconClass} />;
  if (['wasm', 'o', 'obj', 'hex', 'bin', 'elf', 'dll', 'so', 'dylib', 'sys'].includes(ext)) return <Binary className={iconClass} />;

  // 2. Data, Config & DevOps
  if (['json', 'json5', 'jsonc'].includes(ext)) return <FileJson className={iconClass} />;
  if (['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'].includes(ext)) return <Settings className={iconClass} />;
  if (['tf', 'tfstate'].includes(ext)) return <Server className={iconClass} />;
  if (['dockerfile', 'dockerignore'].includes(ext) || filename.toLowerCase().includes('docker')) return <Container className={iconClass} />;
  if (['makefile', 'cmakelists.txt', 'gradle', 'pom.xml'].includes(ext) || filename.toLowerCase() === 'makefile') return <Wrench className={iconClass} />;

  // 3. Video Formats
  if (['mp4', 'm4v', 'mkv', 'webm', 'mov', 'qt', 'avi', 'ts', 'm2ts', 'mts', 'flv', 'f4v', 'swf', 'wmv', 'asf', 'ogv', '3gp', '3g2'].includes(ext)) return <Video className={iconClass} />;
  if (['prores', 'dnxhd', 'dnxhr', 'braw', 'r3d', 'arri'].includes(ext)) return <Clapperboard className={iconClass} />;

  // 4. Image Formats
  if (['jpeg', 'jpg', 'jfif', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'dib', 'tga', 'dds', 'jxl'].includes(ext)) return <ImageIcon className={iconClass} />;
  if (['raw', 'dng', 'cr3', 'nef', 'arw'].includes(ext)) return <Camera className={iconClass} />;
  if (['svg', 'eps', 'ai', 'cdr'].includes(ext)) return <PenTool className={iconClass} />;
  if (['psd', 'psb', 'indd', 'xcf'].includes(ext)) return <Palette className={iconClass} />;
  if (['ico', 'cur'].includes(ext)) return <ImageIcon className={iconClass} />;
  if (['exr', 'hdr'].includes(ext)) return <ImageIcon className={iconClass} />;

  // 5. Audio Formats
  if (['mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'wave', 'flac', 'alac', 'aiff', 'aif', 'wma', 'amr', '3ga'].includes(ext)) return <Music className={iconClass} />;
  if (['m4b'].includes(ext)) return <Headphones className={iconClass} />;
  if (['dsd', 'dsf', 'dff', 'ac3', 'e-ac3', 'dts', 'dts-hd'].includes(ext)) return <Radio className={iconClass} />;
  if (['mid', 'midi'].includes(ext)) return <Mic className={iconClass} />;

  // 6. 3D & CAD
  if (['obj', 'fbx', 'stl', 'gltf', 'glb', 'blend', 'max', '3ds', 'ma', 'mb', 'c4d', 'skp', 'ply', 'x3d', 'amf'].includes(ext)) return <Box className={iconClass} />;
  if (['dwg', 'dxf', 'step', 'stp', 'iges', 'igs'].includes(ext)) return <Shapes className={iconClass} />;

  // 7. Archives & Disk Images
  if (['zip', 'rar', 'rev', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz'].includes(ext)) return <Archive className={iconClass} />;
  if (['iso', 'img', 'dmg', 'vhd', 'vhdx', 'vmdk', 'vdi'].includes(ext)) return <Disc className={iconClass} />;

  // 8. Executables & Fonts
  if (['exe', 'com', 'msi', 'msix', 'app', 'apk', 'aab', 'ipa', 'deb', 'rpm'].includes(ext)) return <AppWindow className={iconClass} />;
  if (['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext)) return <Type className={iconClass} />;

  // 9. Documents
  if (['pdf'].includes(ext)) return <FileText className={iconClass} />;
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return <FileText className={iconClass} />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <Table className={iconClass} />;
  if (['ppt', 'pptx', 'odp'].includes(ext)) return <MonitorPlay className={iconClass} />;
  if (['epub', 'mobi', 'azw3'].includes(ext)) return <Book className={iconClass} />;
  if (['md'].includes(ext)) return <FileText className={iconClass} />;
  if (['cbr', 'cbz'].includes(ext)) return <Library className={iconClass} />;

  // Fallback based on Mime
  if (mimeType.startsWith('video/')) return <Video className={iconClass} />;
  if (mimeType.startsWith('audio/')) return <Music className={iconClass} />;
  if (mimeType.startsWith('image/')) return <ImageIcon className={iconClass} />;
  if (mimeType.startsWith('text/')) return <FileText className={iconClass} />;

  return <File className={iconClass} />;
}
