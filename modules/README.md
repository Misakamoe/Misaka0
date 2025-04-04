## 模块开发指南

本目录用于存放 Bot 的功能模块。每个模块是独立的，可以单独启用或禁用。

### 模块结构

一个基本的模块应包含以下内容：

```py
# 模块元数据
MODULE_NAME = "模块名称"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "模块描述"
MODULE_DEPENDENCIES = []  # 依赖的其他模块列表

def setup(application, bot):
    """模块初始化函数，必须实现"""
    # 在这里注册命令、处理器等
    pass

def cleanup(application, bot):
    """模块清理函数，可选但推荐实现"""
    # 在这里清理资源、移除处理器等
    pass
```

### 开发新模块

1. 创建一个新的 Python 文件，例如 `my_module.py`

2. 实现必要的函数和定义元数据

3. 通过 `/enable my_module` 命令启用模块

### 模块示例

参考 `echo.py` 模块，它实现了一个简单的回显功能。

### 最佳实践

- 保持模块独立，避免与其他模块产生不必要的依赖
- 正确实现 `cleanup` 函数以确保模块可以干净地卸载
- 使用 `MODULE_DEPENDENCIES` 声明依赖关系
- 在模块中使用 `logging` 而不是 `print` 进行日志记录
- 避免修改全局状态，使用模块级变量存储状态
