from setuptools import setup

setup(
    name="agent-world-sdk",
    version="0.1.0",
    description="SDK for connecting AI agents to the Agent World Protocol",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="0xMerl99",
    url="https://github.com/0xMerl99/Agent-World-Protocol",
    py_modules=["agent_world_sdk"],
    python_requires=">=3.8",
    install_requires=["websocket-client>=1.0.0"],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Topic :: Software Development :: Libraries",
    ],
)
