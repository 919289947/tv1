@echo off
setlocal
set APP_HOME=%~dp0
set WRAPPER_JAR=%APP_HOME%gradle\wrapper\gradle-wrapper.jar
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%..\tools\bootstrap-gradle-wrapper.ps1"
if errorlevel 1 exit /b 1
if not exist "%WRAPPER_JAR%" (
  echo ERROR: Gradle Wrapper JAR is missing.
  exit /b 1
)
java %JAVA_OPTS% %GRADLE_OPTS% -Dorg.gradle.appname=gradlew -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
endlocal
